const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "modpapai@gmail.com";
const OTP_TTL = 5 * 60 * 1000;
const SESSION_TTL = 15 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const PRODUCTS_FILE = path.join(__dirname, "products.json");
const CONTACTS_FILE = path.join(__dirname, "contacts.json");
const ADMINS_FILE = path.join(__dirname, "admins.json");

app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "first.html"));
});

let otpData = null;
const sessions = new Map();

function cleanEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function loadProducts() {
    try {
        if (!fs.existsSync(PRODUCTS_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error("PRODUCT LOAD ERROR:", error.message);
        return [];
    }
}

function saveProducts(products) {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), "utf8");
}

function parseCookies(req) {
    const result = {};
    const header = req.headers.cookie || "";
    header.split(";").forEach(part => {
        const index = part.indexOf("=");
        if (index < 0) return;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        result[key] = decodeURIComponent(value);
    });
    return result;
}

function createSession(res, email, role) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL;
    sessions.set(token, { expiresAt, email, role });

    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader(
        "Set-Cookie",
        `gmc_admin_session=${token}; Max-Age=900; Path=/; HttpOnly; SameSite=Lax${secure}`
    );
    return expiresAt;
}

function getSession(req) {
    const token = parseCookies(req).gmc_admin_session;
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() >= session.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return { token, ...session };
}

function requireAdmin(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ message: "Admin session expired. Please login again." });
    req.adminSession = session;
    next();
}

function requireSuperAdmin(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ message: "Admin session expired. Please login again." });
    if (session.role !== "super") return res.status(403).json({ message: "Super Admin access required." });
    req.adminSession = session;
    next();
}

function clearSession(res, req) {
    const session = getSession(req);
    if (session) sessions.delete(session.token);
    res.setHeader("Set-Cookie", "gmc_admin_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
}

function loadAdmins() {
    try {
        if (!fs.existsSync(ADMINS_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(ADMINS_FILE, "utf8"));
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error("ADMIN LOAD ERROR:", error.message);
        return [];
    }
}

function saveAdmins(admins) {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify(admins, null, 2), "utf8");
}

function isSuperAdmin(email) {
    return cleanEmail(email) === ADMIN_EMAIL;
}

function isAllowedAdmin(email) {
    const normalized = cleanEmail(email);
    return normalized === ADMIN_EMAIL || loadAdmins().some(a => cleanEmail(a.email) === normalized);
}

function getRole(email) {
    return isSuperAdmin(email) ? "super" : "admin";
}

const MAILJET_API_KEY = process.env.MAILJET_API_KEY || "";
const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "modpapai@gmail.com";

async function sendEmail({ to, subject, textPart, htmlPart, replyTo }) {
    if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
        throw new Error("Mailjet API credentials are not configured.");
    }

    const payload = {
        Messages: [{
            From: {
                Email: MAIL_FROM,
                Name: "GMC Website"
            },
            To: [{
                Email: to
            }],
            Subject: subject,
            TextPart: textPart,
            HTMLPart: htmlPart
        }]
    };

    if (replyTo) {
        payload.Messages[0].ReplyTo = {
            Email: replyTo
        };
    }

    const auth = Buffer
        .from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`)
        .toString("base64");

    const response = await fetch("https://api.mailjet.com/v3.1/send", {
        method: "POST",
        headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    const body = await response.text();

    if (!response.ok) {
        throw new Error(`Mailjet API ${response.status}: ${body}`);
    }

    let result;
    try {
        result = JSON.parse(body);
    } catch {
        throw new Error("Mailjet returned an invalid response.");
    }

    const messageStatus = result?.Messages?.[0]?.Status;
    if (messageStatus && messageStatus.toLowerCase() !== "success") {
        throw new Error(`Mailjet rejected the message: ${body}`);
    }

    return result;
}

console.log("================================");
console.log("GMC ADMIN SERVER");
console.log("================================");
console.log("MAILJET API KEY:", MAILJET_API_KEY ? "SET" : "NOT SET");
console.log("MAIL FROM:", MAIL_FROM);

/* OTP */
app.post("/api/send-otp", async (req, res) => {
    const email = cleanEmail(req.body.email);
    console.log("OTP REQUEST:", email);

    if (!email || !isAllowedAdmin(email)) return res.status(403).json({ message: "This email is not authorized for admin access." });
    if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
        return res.status(500).json({ message: "Mailjet email service is not configured." });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    otpData = {
        email,
        hash: crypto.createHash("sha256").update(otp).digest("hex"),
        expires: Date.now() + OTP_TTL,
        attempts: 0
    };

    const roleName = getRole(email) === "super" ? "Super Admin" : "Admin";

    try {
        await sendEmail({
            to: email,
            subject: "GMC Admin Login OTP",
            textPart: `Your GMC ${roleName} verification code is: ${otp}\n\nThis OTP expires in 5 minutes. If you did not request this code, ignore this email.`,
            htmlPart: `<div style="font-family:Arial,sans-serif;background:#080808;color:#fff;padding:30px"><div style="max-width:500px;margin:auto;border:1px solid #ff2222;border-radius:14px;padding:28px;background:#0d0d0d"><h2 style="color:#ff2222;margin-top:0">GMC ADMIN</h2><p>Your ${escapeHtml(roleName)} verification code is:</p><div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#fff;background:#151515;border:1px solid #333;border-radius:10px;padding:16px;text-align:center">${otp}</div><p style="color:#999">This OTP expires in 5 minutes and can only be used once.</p></div></div>`
        });
        console.log("OTP EMAIL SENT TO:", email);
        return res.json({ message: `OTP sent to ${email}.` });
    } catch (error) {
        otpData = null;
        console.error("EMAIL SEND FAILED:", error);
        return res.status(500).json({ message: "Failed to send OTP. Check Mailjet settings and sender verification." });
    }
});

app.post("/api/verify-otp", (req, res) => {
    const email = cleanEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();

    if (!isAllowedAdmin(email)) return res.status(403).json({ message: "This email is not authorized for admin access." });
    if (!otpData || otpData.email !== email) return res.status(400).json({ message: "No OTP requested for this email." });
    if (Date.now() >= otpData.expires) {
        otpData = null;
        return res.status(400).json({ message: "OTP expired. Request a new OTP." });
    }
    if (otpData.attempts >= MAX_OTP_ATTEMPTS) {
        otpData = null;
        return res.status(429).json({ message: "Too many attempts. Request a new OTP." });
    }

    otpData.attempts++;
    const hash = crypto.createHash("sha256").update(otp).digest("hex");
    if (hash !== otpData.hash) return res.status(401).json({ message: "Invalid OTP." });

    otpData = null;
    const role = getRole(email);
    const expiresAt = createSession(res, email, role);
    console.log(`${role.toUpperCase()} LOGIN SUCCESS — SESSION 15 MINUTES — ${email}`);
    return res.json({ message: "OTP verified. Admin access granted.", expiresAt, role, email });
});

app.get("/api/admin-status", (req, res) => {
    const session = getSession(req);
    res.json({ authenticated: !!session, expiresAt: session ? session.expiresAt : 0, role: session ? session.role : null, email: session ? session.email : null });
});

app.post("/api/logout", (req, res) => {
    clearSession(res, req);
    res.json({ message: "Logged out." });
});


/* Admin management — Super Admin only */
app.get("/api/admins", requireSuperAdmin, (req, res) => {
    res.json(loadAdmins().map(a => ({ email: a.email })));
});

app.post("/api/admins", requireSuperAdmin, (req, res) => {
    const email = cleanEmail(req.body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Enter a valid admin email." });
    if (email === ADMIN_EMAIL) return res.status(400).json({ message: "Super Admin email is already configured." });
    const admins = loadAdmins();
    if (admins.some(a => cleanEmail(a.email) === email)) return res.status(409).json({ message: "This admin email already exists." });
    admins.push({ email, createdAt: new Date().toISOString() });
    saveAdmins(admins);
    res.status(201).json({ message: "Admin email added.", admins: admins.map(a => ({ email: a.email })) });
});

app.delete("/api/admins/:email", requireSuperAdmin, (req, res) => {
    const email = cleanEmail(decodeURIComponent(req.params.email));
    if (email === ADMIN_EMAIL) return res.status(400).json({ message: "Super Admin cannot be removed." });
    const admins = loadAdmins();
    const filtered = admins.filter(a => cleanEmail(a.email) !== email);
    if (filtered.length === admins.length) return res.status(404).json({ message: "Admin email not found." });
    saveAdmins(filtered);
    res.json({ message: "Admin email removed." });
});

/* Contact settings */
function loadContacts() {
    try {
        if (!fs.existsSync(CONTACTS_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8"));
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error("CONTACT LOAD ERROR:", error.message);
        return [];
    }
}

function saveContacts(contacts) {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), "utf8");
}

app.get("/api/contacts", (req, res) => {
    res.json(loadContacts());
});

app.put("/api/contacts", requireAdmin, (req, res) => {
    const incoming = Array.isArray(req.body.contacts) ? req.body.contacts : [];
    if (!incoming.length || incoming.length > 12) {
        return res.status(400).json({ message: "Invalid contact list." });
    }

    const contacts = incoming.map((item, index) => ({
        id: String(item.id || `contact-${index + 1}`).trim().slice(0, 50),
        icon: String(item.icon || "◉").trim().slice(0, 8),
        title: String(item.title || "CONTACT").trim().slice(0, 60),
        description: String(item.description || "").trim().slice(0, 200),
        text: String(item.text || "").trim().slice(0, 200),
        url: String(item.url || "").trim().slice(0, 1000)
    }));

    saveContacts(contacts);
    res.json({ message: "Contact information saved.", contacts });
});

/* Products */
// Image proxy: lets product images work even when the image host blocks direct hotlinking.
function getGoogleDriveFileId(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        if (!host.includes("drive.google.com") && !host.includes("docs.google.com")) return null;

        // /file/d/FILE_ID/view
        const fileMatch = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (fileMatch) return fileMatch[1];

        // /open?id=FILE_ID, /uc?id=FILE_ID, /uc?export=view&id=FILE_ID
        const id = u.searchParams.get("id");
        if (id && /^[a-zA-Z0-9_-]+$/.test(id)) return id;
        return null;
    } catch {
        return null;
    }
}

function buildImageTargets(rawUrl) {
    const driveId = getGoogleDriveFileId(rawUrl);
    if (driveId) {
        // Google Drive has several public image endpoints. Try the thumbnail
        // endpoint first because it reliably returns image bytes for public files.
        return [
            `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveId)}&sz=w1600`,
            `https://drive.google.com/uc?export=view&id=${encodeURIComponent(driveId)}`,
            `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveId)}&export=download&confirm=t`
        ];
    }
    return [rawUrl];
}

app.get("/api/image-proxy", async (req, res) => {
    const raw = String(req.query.url || "").trim();
    if (!raw) return res.status(400).send("Missing image URL.");

    const targets = buildImageTargets(raw);
    let lastStatus = 502;
    let lastMessage = "Unable to fetch image.";

    for (const targetUrl of targets) {
        let target;
        try {
            target = new URL(targetUrl);
        } catch {
            continue;
        }
        if (!/^https?:$/.test(target.protocol)) continue;

        try {
            const response = await fetch(target, {
                redirect: "follow",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
                }
            });

            if (!response.ok) {
                lastStatus = response.status;
                lastMessage = `Image request failed (${response.status}).`;
                continue;
            }

            const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > 8 * 1024 * 1024) {
                return res.status(413).send("Image is too large (max 8 MB).");
            }

            // Ignore Drive login/permission pages returned as HTML and try the
            // next public endpoint instead.
            if (!type.startsWith("image/")) {
                lastStatus = 415;
                lastMessage = "Google Drive did not return an image. Make the file public.";
                continue;
            }

            res.setHeader("Cache-Control", "public, max-age=3600");
            res.setHeader("Content-Type", type);
            return res.send(buffer);
        } catch (error) {
            lastStatus = 502;
            lastMessage = error.message || "Unable to fetch image.";
        }
    }

    console.error("IMAGE PROXY FAILED:", raw, lastMessage);
    return res.status(lastStatus).send(
        lastStatus === 415
            ? "Google Drive image is not publicly accessible. Set General access to Anyone with the link -> Viewer."
            : lastMessage
    );
});

app.get("/api/products", (req, res) => {
    res.json(loadProducts());
});

app.post("/api/products", requireAdmin, (req, res) => {
    const body = req.body || {};
    if (!String(body.name || "").trim()) return res.status(400).json({ message: "Product name is required." });

    const products = loadProducts();
    const product = {
        id: crypto.randomUUID(),
        icon: String(body.icon || "📦").trim(),
        tag: String(body.tag || "NEW").trim(),
        name: String(body.name).trim(),
        description: String(body.description || "").trim(),
        contentType: body.contentType === "image" ? "image" : "plans",
        imageUrl: String(body.imageUrl || "").trim(),
        plans: Array.isArray(body.plans) ? body.plans.slice(0, 20) : [],
        buttons: Array.isArray(body.buttons) && body.buttons.length ? body.buttons.slice(0, 2) : [{ text: String(body.buttonText || "GET PRODUCT"), link: String(body.buttonLink || "#") }]
    };
    products.push(product);
    saveProducts(products);
    res.status(201).json(product);
});

app.put("/api/products/:id", requireAdmin, (req, res) => {
    const products = loadProducts();
    const index = products.findIndex(p => p.id === req.params.id);
    if (index < 0) return res.status(404).json({ message: "Product not found." });

    const old = products[index];
    const body = req.body || {};
    products[index] = {
        ...old,
        icon: String(body.icon ?? old.icon ?? "📦").trim(),
        tag: String(body.tag ?? old.tag ?? "NEW").trim(),
        name: String(body.name ?? old.name ?? "").trim(),
        description: String(body.description ?? old.description ?? "").trim(),
        contentType: body.contentType === "image" ? "image" : (body.contentType === "plans" ? "plans" : (old.contentType || "plans")),
        imageUrl: String(body.imageUrl ?? old.imageUrl ?? "").trim(),
        plans: Array.isArray(body.plans) ? body.plans.slice(0, 20) : (old.plans || []),
        buttons: Array.isArray(body.buttons) && body.buttons.length ? body.buttons.slice(0, 2) : (old.buttons || [{ text: "GET PRODUCT", link: "#" }])
    };
    if (!products[index].name) return res.status(400).json({ message: "Product name is required." });
    saveProducts(products);
    res.json(products[index]);
});

app.delete("/api/products/:id", requireAdmin, (req, res) => {
    const products = loadProducts();
    const filtered = products.filter(p => p.id !== req.params.id);
    if (filtered.length === products.length) return res.status(404).json({ message: "Product not found." });
    saveProducts(filtered);
    res.json({ message: "Product deleted." });
});

/* Contact form */
app.post("/api/contact", async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim();
    const subject = String(req.body.subject || "").trim();
    const phone = String(req.body.phone || "").trim();
    const message = String(req.body.message || "").trim();

    // Contact number is optional.
    if (!name || !email || !subject || !message) return res.status(400).json({ message: "Please fill in all required fields." });
    if (name.length > 100 || email.length > 200 || subject.length > 200 || phone.length > 30 || message.length > 5000) return res.status(400).json({ message: "One or more fields are too long." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email address." });
    if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
        return res.status(500).json({ message: "Mailjet email service is not configured." });
    }

    try {
        await sendEmail({
            to: ADMIN_EMAIL,
            replyTo: email,
            subject: `[GMC Contact] ${subject}`,
            text: `New contact message from GMC website\n\nName: ${name}\nEmail: ${email}\nContact No.: ${phone || "Not provided"}\nSubject: ${subject}\n\nMessage:\n${message}`,
            html: `<!doctype html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#070707;font-family:Arial,Helvetica,sans-serif;color:#f5f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#070707;margin:0;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:#0d0d0d;border:1px solid #4a1116;border-radius:18px;overflow:hidden;">
<tr><td style="padding:24px 28px;background:linear-gradient(135deg,#160709,#0d0d0d);border-bottom:1px solid #4a1116;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td><div style="font-size:28px;font-weight:900;letter-spacing:3px;color:#ffffff;">GMC</div><div style="font-size:10px;letter-spacing:2px;color:#ff2029;margin-top:4px;font-weight:700;">WEBSITE CONTACT</div></td>
<td align="right"><span style="display:inline-block;padding:7px 11px;border:1px solid #ff2029;border-radius:999px;color:#ff3038;font-size:10px;font-weight:800;letter-spacing:1px;">NEW MESSAGE</span></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
<div style="font-size:24px;font-weight:800;color:#ffffff;margin-bottom:7px;">New Contact Message</div>
<div style="font-size:13px;color:#888;margin-bottom:24px;">Someone submitted the contact form on your GMC website.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #292929;border-radius:12px;overflow:hidden;">
<tr><td style="padding:14px 16px;border-bottom:1px solid #252525;background:#101010;width:120px;color:#888;font-size:11px;font-weight:700;letter-spacing:1px;">NAME</td><td style="padding:14px 16px;border-bottom:1px solid #252525;color:#f2f2f2;font-size:14px;">${escapeHtml(name)}</td></tr>
<tr><td style="padding:14px 16px;border-bottom:1px solid #252525;background:#101010;color:#888;font-size:11px;font-weight:700;letter-spacing:1px;">EMAIL</td><td style="padding:14px 16px;border-bottom:1px solid #252525;font-size:14px;"><a href="mailto:${escapeHtml(email)}" style="color:#ff3038;text-decoration:none;">${escapeHtml(email)}</a></td></tr>
<tr><td style="padding:14px 16px;border-bottom:1px solid #252525;background:#101010;color:#888;font-size:11px;font-weight:700;letter-spacing:1px;">CONTACT NO.</td><td style="padding:14px 16px;border-bottom:1px solid #252525;color:#f2f2f2;font-size:14px;">${phone ? escapeHtml(phone) : "Not provided"}</td></tr>
<tr><td style="padding:14px 16px;background:#101010;color:#888;font-size:11px;font-weight:700;letter-spacing:1px;">SUBJECT</td><td style="padding:14px 16px;color:#f2f2f2;font-size:14px;">${escapeHtml(subject)}</td></tr>
</table>
<div style="margin-top:22px;font-size:11px;color:#888;font-weight:700;letter-spacing:1px;">MESSAGE</div>
<div style="margin-top:8px;padding:18px;background:#101010;border:1px solid #292929;border-radius:12px;color:#e8e8e8;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;">${escapeHtml(message)}</div>
<div style="margin-top:24px;"><a href="mailto:${escapeHtml(email)}?subject=Re: ${encodeURIComponent(subject)}" style="display:inline-block;padding:12px 20px;background:#ef0b12;color:#ffffff;text-decoration:none;border-radius:9px;font-size:12px;font-weight:800;letter-spacing:.4px;">REPLY TO ${escapeHtml(name).toUpperCase()}</a></div>
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #242424;color:#666;font-size:11px;text-align:center;">GMC Website &nbsp;•&nbsp; Automated contact notification</td></tr>
</table>
</td></tr></table>
</body></html>`
        });
        console.log("CONTACT EMAIL SENT FROM:", email);
        res.json({ message: "Message sent successfully." });
    } catch (error) {
        console.error("CONTACT EMAIL FAILED:", error);
        res.status(500).json({ message: "Could not send the message right now. Please try again later." });
    }
});

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
}

app.listen(PORT, () => {
    console.log(`GMC Admin server running on port ${PORT}`);
});
