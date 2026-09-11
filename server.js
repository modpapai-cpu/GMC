require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const jsQR = require("jsqr");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "modpapai@gmail.com";
const OTP_TTL = 5 * 60 * 1000;
const SESSION_TTL = 15 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const TEST_PAYMENT_ENABLED = String(process.env.TEST_PAYMENT_ENABLED || "false").toLowerCase() === "true";

// Razorpay sends webhook signatures over the exact raw request body.
// Keep this parser before the global JSON parser.
app.use("/api/webhooks/razorpay", express.raw({ type: "application/json", limit: "500kb" }));
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "first.html"));
});

/*
 * Persistent storage: Firebase Cloud Firestore
 *
 * Required Render environment variables:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
 *
 * Optional:
 *   FIREBASE_SERVICE_ACCOUNT_JSON
 */
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || "";
const firebaseClientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY || "";
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";

let adminSdk;
try {
    adminSdk = require("firebase-admin");
} catch (error) {
    console.error("Firebase Admin SDK is missing. Run: npm install firebase-admin");
    throw error;
}

let serviceAccount;
if (firebaseServiceAccountJson) {
    try {
        serviceAccount = JSON.parse(firebaseServiceAccountJson);
    } catch (error) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
    }
} else if (firebaseProjectId && firebaseClientEmail && firebasePrivateKey) {
    serviceAccount = {
        projectId: firebaseProjectId,
        clientEmail: firebaseClientEmail,
        privateKey: firebasePrivateKey.replace(/\\n/g, "\n")
    };
} else {
    throw new Error(
        "Firebase is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Render Environment."
    );
}

if (!adminSdk.apps.length) {
    adminSdk.initializeApp({
        credential: adminSdk.credential.cert(serviceAccount)
    });
}

const db = adminSdk.firestore();

const COLLECTIONS = {
    admins: "admins",
    products: "products",
    contacts: "contacts",
    sessions: "admin_sessions",
    otps: "admin_otps",
    purchases: "purchases"
};

function cleanEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function docToData(snapshot) {
    return { id: snapshot.id, ...snapshot.data() };
}

async function loadCollection(name) {
    const snapshot = await db.collection(name).get();
    return snapshot.docs.map(docToData);
}

async function getDocument(name, id) {
    const snapshot = await db.collection(name).doc(id).get();
    return snapshot.exists ? docToData(snapshot) : null;
}

/*
 * Seed only when a collection is empty.
 * This imports the existing JSON data once, but never overwrites
 * data already stored in Firestore on later Render deployments.
 */
async function seedCollectionIfEmpty(name, items, idGetter) {
    const snapshot = await db.collection(name).limit(1).get();
    if (!snapshot.empty || !items.length) return;

    const batch = db.batch();
    for (const item of items) {
        const id = String(idGetter(item));
        batch.set(db.collection(name).doc(id), item);
    }
    await batch.commit();
    console.log(`Seeded ${items.length} records into Firestore/${name}`);
}

async function seedFromJsonFiles() {
    const seeds = [
        ["products", "products.json", item => item.id || crypto.randomUUID()],
        ["admins", "admins.json", item => cleanEmail(item.email) || crypto.randomUUID()],
        ["contacts", "contacts.json", item => item.id || crypto.randomUUID()]
    ];

    for (const [collection, fileName, idGetter] of seeds) {
        const filePath = path.join(__dirname, fileName);
        if (!fs.existsSync(filePath)) continue;

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const items = Array.isArray(parsed) ? parsed : [];
            await seedCollectionIfEmpty(collection, items, idGetter);
        } catch (error) {
            console.error(`SEED ERROR (${fileName}):`, error.message);
        }
    }
}

async function loadProducts() {
    const products = await loadCollection(COLLECTIONS.products);
    return products.sort((a, b) => {
        const ao = Number.isFinite(Number(a.order)) ? Number(a.order) : Number.POSITIVE_INFINITY;
        const bo = Number.isFinite(Number(b.order)) ? Number(b.order) : Number.POSITIVE_INFINITY;
        if (ao !== bo) return ao - bo;
        const ac = String(a.createdAt || "");
        const bc = String(b.createdAt || "");
        return ac.localeCompare(bc);
    });
}

async function loadAdmins() {
    return await loadCollection(COLLECTIONS.admins);
}

async function loadContacts() {
    return await loadCollection(COLLECTIONS.contacts);
}

async function saveCollection(name, items, idGetter) {
    const collection = db.collection(name);
    const existing = await collection.get();

    const incomingIds = new Set(items.map(item => String(idGetter(item))));
    const batch = db.batch();

    for (const doc of existing.docs) {
        if (!incomingIds.has(doc.id)) batch.delete(doc.ref);
    }

    for (const item of items) {
        const id = String(idGetter(item));
        batch.set(collection.doc(id), item);
    }

    await batch.commit();
}

async function isSuperAdmin(email) {
    return cleanEmail(email) === ADMIN_EMAIL;
}

async function isAllowedAdmin(email) {
    const normalized = cleanEmail(email);
    if (normalized === ADMIN_EMAIL) return true;

    const snapshot = await db.collection(COLLECTIONS.admins)
        .where("email", "==", normalized)
        .limit(1)
        .get();

    return !snapshot.empty;
}

function getRole(email) {
    return cleanEmail(email) === ADMIN_EMAIL ? "super" : "admin";
}

/* Email: Mailjet */
const MAILJET_API_KEY = process.env.MAILJET_API_KEY || "";
const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "modpapai@gmail.com";

// Razorpay QR payments — keep these values only in Render/local environment variables.
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const RAZORPAY_QR_TTL_SECONDS = Math.max(300, Number(process.env.RAZORPAY_QR_TTL_SECONDS || 900));
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

function parsePlanAmount(value) {
    const raw = String(value ?? "").trim();
    const cleaned = raw.replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const rupees = Number(cleaned);
    if (!Number.isFinite(rupees) || rupees <= 0) return null;
    const paise = Math.round(rupees * 100);
    return paise > 0 ? paise : null;
}

async function razorpayRequest(endpoint, options = {}) {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        throw new Error("Razorpay API credentials are not configured.");
    }

    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
    const response = await fetch(`https://api.razorpay.com/v1${endpoint}`, {
        ...options,
        headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = { error: { description: text || "Invalid Razorpay response." } };
    }

    if (!response.ok) {
        const message = data?.error?.description || data?.error?.reason || `Razorpay API ${response.status}`;
        throw new Error(message);
    }

    return data;
}



function escapeEmailHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildPurchaseEmail(purchase) {
    const customerName = String(purchase.customerName || "Customer").trim() || "Customer";
    const productName = String(purchase.productName || "GMC Product").trim();
    const planLabel = String(purchase.planLabel || "Package").trim();
    const amount = Number(purchase.amountPaise || 0) / 100;
    const mode = ["license", "userpass", "off"].includes(purchase.credentialMode)
        ? purchase.credentialMode
        : "license";
    const licenseKey = String(purchase.licenseKey || "").trim();
    const account = purchase.account && typeof purchase.account === "object"
        ? { username: String(purchase.account.username || "").trim(), password: String(purchase.account.password || "") }
        : null;
    const downloadUrl = String(purchase.downloadUrl || "").trim();

    let credentialHtml = "";
    let credentialText = "";
    if (mode === "license" && licenseKey) {
        credentialHtml = `
            <div style="margin:24px 0;padding:20px;border:1px solid #333;border-radius:14px;background:#111;color:#fff;">
                <div style="font-size:12px;font-weight:800;letter-spacing:1.5px;color:#ff2b2b;margin-bottom:10px;">YOUR LICENSE KEY</div>
                <div style="font-size:20px;font-weight:800;letter-spacing:1px;word-break:break-all;color:#fff;">${escapeEmailHtml(licenseKey)}</div>
                <div style="margin-top:8px;font-size:12px;color:#999;">Keep this key private and do not share it.</div>
            </div>`;
        credentialText = `\nLICENSE KEY: ${licenseKey}\nKeep this key private and do not share it.\n`;
    } else if (mode === "userpass" && account?.username && account?.password) {
        credentialHtml = `
            <div style="margin:24px 0;padding:20px;border:1px solid #333;border-radius:14px;background:#111;color:#fff;">
                <div style="font-size:12px;font-weight:800;letter-spacing:1.5px;color:#ff2b2b;margin-bottom:12px;">YOUR LOGIN DETAILS</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="color:#fff;font-size:14px;">
                    <tr><td style="padding:7px 0;color:#999;width:90px;">Username</td><td style="padding:7px 0;font-weight:800;word-break:break-all;">${escapeEmailHtml(account.username)}</td></tr>
                    <tr><td style="padding:7px 0;color:#999;">Password</td><td style="padding:7px 0;font-weight:800;word-break:break-all;">${escapeEmailHtml(account.password)}</td></tr>
                </table>
                <div style="margin-top:8px;font-size:12px;color:#999;">Keep these login details private.</div>
            </div>`;
        credentialText = `\nUSERNAME: ${account.username}\nPASSWORD: ${account.password}\nKeep these login details private.\n`;
    }

    const downloadHtml = downloadUrl
        ? `<a href="${escapeEmailHtml(downloadUrl)}" style="display:inline-block;background:#ff1111;color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:14px 24px;border-radius:10px;">DOWNLOAD GMC TOOL</a>`
        : `<div style="padding:14px 16px;border-radius:10px;background:#171717;color:#aaa;font-size:13px;">Your download link will be provided separately.</div>`;
    const downloadText = downloadUrl ? `DOWNLOAD: ${downloadUrl}` : "DOWNLOAD: Link will be provided separately.";

    const htmlPart = `<!doctype html>
<html><body style="margin:0;padding:0;background:#070707;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#070707;padding:28px 10px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border-radius:18px;overflow:hidden;">
<tr><td style="background:#0b0b0b;padding:28px 30px;text-align:center;border-bottom:3px solid #ff1111;">
<div style="font-size:27px;font-weight:900;letter-spacing:1px;color:#fff;">GMC <span style="color:#ff1111;">STEAM TOOL</span></div>
<div style="margin-top:8px;color:#aaa;font-size:12px;letter-spacing:1.5px;">ORDER CONFIRMATION</div>
</td></tr>
<tr><td style="padding:32px 30px;">
<div style="font-size:22px;font-weight:800;color:#111;">Payment successful ✓</div>
<p style="font-size:15px;line-height:1.7;color:#555;margin:10px 0 22px;">Hi <strong>${escapeEmailHtml(customerName)}</strong>, thank you for your purchase. Your GMC order has been confirmed and your access details are below.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;background:#f7f7f7;border-radius:12px;margin-bottom:20px;">
<tr><td style="padding:12px 15px;color:#888;font-size:12px;">PRODUCT</td><td align="right" style="padding:12px 15px;color:#111;font-weight:800;font-size:13px;">${escapeEmailHtml(productName)}</td></tr>
<tr><td style="padding:12px 15px;color:#888;font-size:12px;">PACKAGE</td><td align="right" style="padding:12px 15px;color:#111;font-weight:800;font-size:13px;">${escapeEmailHtml(planLabel)}</td></tr>
<tr><td style="padding:12px 15px;color:#888;font-size:12px;">AMOUNT</td><td align="right" style="padding:12px 15px;color:#111;font-weight:800;font-size:13px;">₹${amount.toLocaleString("en-IN")}</td></tr>
</table>
${credentialHtml}
<div style="margin-top:24px;text-align:center;">
${downloadHtml}
</div>
<p style="font-size:12px;line-height:1.6;color:#999;margin:25px 0 0;text-align:center;">Please keep your license/login details private. If you have any issue with your order, reply to this email for support.</p>
</td></tr>
<tr><td style="background:#0b0b0b;padding:20px 30px;text-align:center;color:#777;font-size:11px;">© GMC Steam Tool · Automated purchase delivery</td></tr>
</table></td></tr></table>
</body></html>`;

    const textPart = `GMC STEAM TOOL\n\nPayment successful ✓\n\nHi ${customerName}, thank you for your purchase.\n\nPRODUCT: ${productName}\nPACKAGE: ${planLabel}\nAMOUNT: ₹${amount.toLocaleString("en-IN")}\n${credentialText}\n${downloadText}\n\nPlease keep your access details private.`;
    return { htmlPart, textPart };
}

async function deliverPurchaseEmail(purchaseId) {
    const ref = db.collection(COLLECTIONS.purchases).doc(String(purchaseId));
    const snap = await ref.get();
    if (!snap.exists) return { sent: false, skipped: true };
    const purchase = { id: snap.id, ...snap.data() };
    if (purchase.status !== "paid") return { sent: false, skipped: true };
    if (purchase.deliveryEmailSentAt) return { sent: true, alreadySent: true };
    const customerEmail = cleanEmail(purchase.customerEmail);
    if (!customerEmail) return { sent: false, skipped: true };

    const now = Date.now();
    let claimed = false;
    await db.runTransaction(async tx => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) return;
        const data = fresh.data();
        if (data.status !== "paid" || data.deliveryEmailSentAt) return;
        const claimedAt = Number(data.deliveryEmailClaimedAt || 0);
        if (data.deliveryEmailStatus === "sending" && claimedAt && now - claimedAt < 5 * 60 * 1000) return;
        tx.update(ref, { deliveryEmailStatus: "sending", deliveryEmailClaimedAt: now, deliveryEmailError: null });
        claimed = true;
    });

    if (!claimed) return { sent: false, claimedByOther: true };

    try {
        const fresh = await ref.get();
        const data = { id: fresh.id, ...fresh.data() };
        const { htmlPart, textPart } = buildPurchaseEmail(data);
        await sendEmail({
            to: customerEmail,
            subject: `GMC Order Confirmed — ${data.productName || "Your Purchase"}`,
            textPart,
            htmlPart
        });
        await ref.update({
            deliveryEmailStatus: "sent",
            deliveryEmailSentAt: adminSdk.firestore.FieldValue.serverTimestamp(),
            deliveryEmailClaimedAt: null,
            deliveryEmailError: null
        });
        return { sent: true };
    } catch (error) {
        await ref.update({
            deliveryEmailStatus: "failed",
            deliveryEmailClaimedAt: null,
            deliveryEmailError: String(error.message || "Unable to send delivery email.").slice(0, 1000)
        }).catch(() => {});
        throw error;
    }
}

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
        payload.Messages[0].ReplyTo = { Email: replyTo };
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
console.log("FIREBASE:", serviceAccount ? "SET" : "NOT SET");
console.log("MAILJET API KEY:", MAILJET_API_KEY ? "SET" : "NOT SET");
console.log("MAIL FROM:", MAIL_FROM);

/* OTP — stored per email in Firestore, so simultaneous logins do not overwrite each other. */
app.post("/api/send-otp", async (req, res) => {
    const email = cleanEmail(req.body.email);
    console.log("OTP REQUEST:", email);

    try {
        if (!email || !(await isAllowedAdmin(email))) {
            return res.status(403).json({ message: "This email is not authorized for admin access." });
        }

        if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
            return res.status(500).json({ message: "Mailjet email service is not configured." });
        }

        const otp = crypto.randomInt(100000, 1000000).toString();
        const otpDocId = encodeURIComponent(email);
        const otpHash = crypto.createHash("sha256").update(otp).digest("hex");

        await db.collection(COLLECTIONS.otps).doc(otpDocId).set({
            email,
            hash: otpHash,
            expires: Date.now() + OTP_TTL,
            attempts: 0,
            createdAt: adminSdk.firestore.FieldValue.serverTimestamp()
        });

        const roleName = getRole(email) === "super" ? "Super Admin" : "Admin";

        try {
            await sendEmail({
                to: email,
                subject: "GMC Admin Login OTP",
                textPart: `Your GMC ${roleName} verification code is: ${otp}

This OTP expires in 5 minutes. If you did not request this code, ignore this email.`,
                htmlPart: `<div style="font-family:Arial,sans-serif;background:#080808;color:#fff;padding:30px"><div style="max-width:500px;margin:auto;border:1px solid #ff2222;border-radius:14px;padding:28px;background:#0d0d0d"><h2 style="color:#ff2222;margin-top:0">GMC ADMIN</h2><p>Your ${escapeHtml(roleName)} verification code is:</p><div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#fff;background:#151515;border:1px solid #333;border-radius:10px;padding:16px;text-align:center">${otp}</div><p style="color:#999">This OTP expires in 5 minutes and can only be used once.</p></div></div>`
            });

            console.log("OTP EMAIL SENT TO:", email);
            return res.json({ message: `OTP sent to ${email}.` });
        } catch (error) {
            await db.collection(COLLECTIONS.otps).doc(otpDocId).delete().catch(() => {});
            console.error("EMAIL SEND FAILED:", error);
            return res.status(500).json({ message: "Failed to send OTP. Check Mailjet settings and sender verification." });
        }
    } catch (error) {
        console.error("OTP REQUEST FAILED:", error);
        return res.status(500).json({ message: "Unable to process OTP request." });
    }
});

app.post("/api/verify-otp", async (req, res) => {
    const email = cleanEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();

    try {
        if (!(await isAllowedAdmin(email))) {
            return res.status(403).json({ message: "This email is not authorized for admin access." });
        }

        const otpDocId = encodeURIComponent(email);
        const ref = db.collection(COLLECTIONS.otps).doc(otpDocId);
        const snapshot = await ref.get();

        if (!snapshot.exists) {
            return res.status(400).json({ message: "No OTP requested for this email." });
        }

        const otpData = snapshot.data();

        if (Date.now() >= otpData.expires) {
            await ref.delete();
            return res.status(400).json({ message: "OTP expired. Request a new OTP." });
        }

        if ((otpData.attempts || 0) >= MAX_OTP_ATTEMPTS) {
            await ref.delete();
            return res.status(429).json({ message: "Too many attempts. Request a new OTP." });
        }

        const nextAttempts = (otpData.attempts || 0) + 1;
        await ref.update({ attempts: nextAttempts });

        const hash = crypto.createHash("sha256").update(otp).digest("hex");
        if (hash !== otpData.hash) {
            return res.status(401).json({ message: "Invalid OTP." });
        }

        await ref.delete();

        const role = getRole(email);
        const expiresAt = await createSession(res, email, role);
        console.log(`${role.toUpperCase()} LOGIN SUCCESS — SESSION 15 MINUTES — ${email}`);
        return res.json({ message: "OTP verified. Admin access granted.", expiresAt, role, email });
    } catch (error) {
        console.error("OTP VERIFY FAILED:", error);
        return res.status(500).json({ message: "Unable to verify OTP." });
    }
});

/* Sessions — persistent in Firestore so a Render restart does not silently log everyone out. */
async function createSession(res, email, role) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL;

    await db.collection(COLLECTIONS.sessions).doc(token).set({
        email,
        role,
        expiresAt,
        createdAt: adminSdk.firestore.FieldValue.serverTimestamp()
    });

    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader(
        "Set-Cookie",
        `gmc_admin_session=${token}; Max-Age=900; Path=/; HttpOnly; SameSite=Lax${secure}`
    );

    return expiresAt;
}

function parseCookies(req) {
    const result = {};
    const header = req.headers.cookie || "";
    header.split(";").forEach(part => {
        const index = part.indexOf("=");
        if (index < 0) return;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        try {
            result[key] = decodeURIComponent(value);
        } catch {
            result[key] = value;
        }
    });
    return result;
}

async function getSession(req) {
    const token = parseCookies(req).gmc_admin_session;
    if (!token) return null;

    const snapshot = await db.collection(COLLECTIONS.sessions).doc(token).get();
    if (!snapshot.exists) return null;

    const data = snapshot.data();
    if (Date.now() >= Number(data.expiresAt || 0)) {
        await snapshot.ref.delete().catch(() => {});
        return null;
    }

    return { token, ...data };
}

async function requireAdmin(req, res, next) {
    try {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ message: "Admin session expired. Please login again." });
        req.adminSession = session;
        next();
    } catch (error) {
        console.error("SESSION CHECK ERROR:", error);
        return res.status(500).json({ message: "Unable to check admin session." });
    }
}

async function requireSuperAdmin(req, res, next) {
    try {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ message: "Admin session expired. Please login again." });
        if (session.role !== "super") return res.status(403).json({ message: "Super Admin access required." });
        req.adminSession = session;
        next();
    } catch (error) {
        console.error("SUPER SESSION CHECK ERROR:", error);
        return res.status(500).json({ message: "Unable to check admin session." });
    }
}

async function clearSession(res, req) {
    const session = await getSession(req);
    if (session) await db.collection(COLLECTIONS.sessions).doc(session.token).delete().catch(() => {});
    res.setHeader("Set-Cookie", "gmc_admin_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
}

app.get("/api/admin-status", async (req, res) => {
    try {
        const session = await getSession(req);
        res.json({
            authenticated: !!session,
            expiresAt: session ? session.expiresAt : 0,
            role: session ? session.role : null,
            email: session ? session.email : null
        });
    } catch (error) {
        console.error("ADMIN STATUS ERROR:", error);
        res.status(500).json({ authenticated: false, expiresAt: 0, role: null, email: null });
    }
});

app.post("/api/logout", async (req, res) => {
    try {
        // Revoke the server-side session when possible.
        const session = await getSession(req);
        if (session) {
            await db.collection(COLLECTIONS.sessions).doc(session.token).delete().catch(() => {});
        }
    } catch (error) {
        console.error("LOGOUT SESSION REVOKE ERROR:", error);
    }

    // Always expire the browser cookie, even if the session is already gone.
    res.setHeader(
        "Set-Cookie",
        "gmc_admin_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax"
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.json({ message: "Logged out." });
});

/* Admin management — Super Admin only */
app.get("/api/admins", requireSuperAdmin, async (req, res) => {
    try {
        res.json((await loadAdmins()).map(a => ({ email: a.email })));
    } catch (error) {
        console.error("ADMIN LIST ERROR:", error);
        res.status(500).json({ message: "Unable to load admins." });
    }
});

app.post("/api/admins", requireSuperAdmin, async (req, res) => {
    try {
        const email = cleanEmail(req.body.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Enter a valid admin email." });
        if (email === ADMIN_EMAIL) return res.status(400).json({ message: "Super Admin email is already configured." });

        const ref = db.collection(COLLECTIONS.admins).doc(encodeURIComponent(email));
        if ((await ref.get()).exists) return res.status(409).json({ message: "This admin email already exists." });

        await ref.set({ email, createdAt: new Date().toISOString() });
        res.status(201).json({ message: "Admin email added.", admins: (await loadAdmins()).map(a => ({ email: a.email })) });
    } catch (error) {
        console.error("ADMIN ADD ERROR:", error);
        res.status(500).json({ message: "Unable to add admin." });
    }
});

app.delete("/api/admins/:email", requireSuperAdmin, async (req, res) => {
    try {
        const email = cleanEmail(decodeURIComponent(req.params.email));
        if (email === ADMIN_EMAIL) return res.status(400).json({ message: "Super Admin cannot be removed." });

        const ref = db.collection(COLLECTIONS.admins).doc(encodeURIComponent(email));
        if (!(await ref.get()).exists) return res.status(404).json({ message: "Admin email not found." });

        await ref.delete();
        res.json({ message: "Admin email removed." });
    } catch (error) {
        console.error("ADMIN DELETE ERROR:", error);
        res.status(500).json({ message: "Unable to remove admin." });
    }
});

/* Contact settings */
app.get("/api/contacts", async (req, res) => {
    try {
        res.json(await loadContacts());
    } catch (error) {
        console.error("CONTACT LOAD ERROR:", error);
        res.status(500).json({ message: "Unable to load contact information." });
    }
});

app.put("/api/contacts", requireAdmin, async (req, res) => {
    try {
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

        await saveCollection(COLLECTIONS.contacts, contacts, item => item.id);
        res.json({ message: "Contact information saved.", contacts });
    } catch (error) {
        console.error("CONTACT SAVE ERROR:", error);
        res.status(500).json({ message: "Unable to save contact information." });
    }
});

/* Public runtime config — never expose payment credentials. */
/* Purchase logs — admin only. Returns completed purchases with delivery details. */
app.get("/api/purchase-logs", requireAdmin, async (req, res) => {
    try {
        const snapshot = await db.collection(COLLECTIONS.purchases).get();
        const logs = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(p => String(p.status || "").toLowerCase() === "paid")
            .sort((a, b) => {
                const ta = a.paidAt?.toMillis?.() || a.createdAt?.toMillis?.() || Number(a.paidAt || a.createdAt || 0) || 0;
                const tb = b.paidAt?.toMillis?.() || b.createdAt?.toMillis?.() || Number(b.paidAt || b.createdAt || 0) || 0;
                return tb - ta;
            })
            .map(p => {
                const account = p.account && typeof p.account === "object" ? p.account : {};
                const amount = Number(p.amountPaise || 0) / 100;
                const planLabel = String(p.planLabel || "").trim();
                return {
                    id: p.id,
                    customerName: String(p.customerName || "").trim(),
                    email: String(p.customerEmail || "").trim(),
                    username: p.credentialMode === "userpass" ? String(account.username || "").trim() : "",
                    password: p.credentialMode === "userpass" ? String(account.password || "") : "",
                    license: p.credentialMode === "license" ? String(p.licenseKey || "").trim() : "",
                    productName: String(p.productName || "").trim(),
                    planDetails: planLabel + (amount ? ` — ₹${amount.toLocaleString("en-IN")}` : ""),
                    purchaseDate: p.paidAt?.toDate?.()?.toISOString?.() || p.createdAt?.toDate?.()?.toISOString?.() || null,
                    paymentId: String(p.paymentId || "").trim(),
                    testPayment: Boolean(p.testPayment)
                };
            });
        res.json({ ok: true, logs });
    } catch (error) {
        console.error("PURCHASE LOGS ERROR:", error);
        res.status(500).json({ message: "Unable to load purchase logs." });
    }
});

app.get("/api/config", (req, res) => {
    res.json({
        ok: true,
        test_payment_enabled: TEST_PAYMENT_ENABLED,
        buy_license_url: process.env.BUY_LICENSE_URL || ""
    });
});

/* Products */
app.get("/api/products", async (req, res) => {
    try {
        res.json(await loadProducts());
    } catch (error) {
        console.error("PRODUCT LIST ERROR:", error);
        res.status(500).json({ message: "Unable to load products." });
    }
});

function normalizeProductPlans(incomingPlans, oldPlans = []) {
    const previous=Array.isArray(oldPlans)?oldPlans:[],used=new Set();
    return (Array.isArray(incomingPlans)?incomingPlans:[]).slice(0,20).map(raw=>{
        const label=String(raw?.label||"").trim(),price=String(raw?.price||"").trim(),iid=String(raw?.id||"").trim();let mi=-1;
        if(iid)mi=previous.findIndex((p,i)=>!used.has(i)&&String(p?.id||"")===iid);
        if(mi<0&&label)mi=previous.findIndex((p,i)=>!used.has(i)&&String(p?.label||"").trim()===label);
        const old=mi>=0?previous[mi]:null;if(mi>=0)used.add(mi);
        const licenses=Array.isArray(raw?.licenses)?raw.licenses.map(x=>String(x).trim()).filter(Boolean).slice(0,5000):(Array.isArray(old?.licenses)?old.licenses.map(x=>String(x).trim()).filter(Boolean).slice(0,5000):[]);
        const accounts=Array.isArray(raw?.accounts)?raw.accounts.map(x=>({username:String(x?.username||"").trim(),password:String(x?.password||"")})).filter(x=>x.username&&x.password).slice(0,5000):(Array.isArray(old?.accounts)?old.accounts.map(x=>({username:String(x?.username||"").trim(),password:String(x?.password||"")})).filter(x=>x.username&&x.password).slice(0,5000):[]);
        const credentialMode=["license","userpass","off"].includes(raw?.credentialMode)?raw.credentialMode:(old?.credentialMode||"license");
        return {id:iid||String(old?.id||crypto.randomUUID()),label,price,licenses,accounts,credentialMode};
    }).filter(p=>p.label||p.price);
}

app.post("/api/products", requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        if (!String(body.name || "").trim()) return res.status(400).json({ message: "Product name is required." });

        const product = {
            id: crypto.randomUUID(),
            icon: String(body.icon || "📦").trim(),
            tag: String(body.tag || "NEW").trim(),
            name: String(body.name).trim(),
            description: String(body.description || "").trim(),
            contentType: ["plans", "image", "both"].includes(body.contentType) ? body.contentType : "plans",
            imageUrl: String(body.imageUrl || "").trim(),
            downloadUrl: String(body.downloadUrl || "").trim(),
            plans: normalizeProductPlans(body.plans, []),
            buttons: Array.isArray(body.buttons) && body.buttons.length
                ? body.buttons.slice(0, 2)
                : [{ text: String(body.buttonText || "GET PRODUCT"), link: String(body.buttonLink || "#") }],
            buyEnabled: Boolean(body.buyEnabled),
            createdAt: new Date().toISOString(),
            order: Date.now()
        };

        await db.collection(COLLECTIONS.products).doc(product.id).set(product);
        res.status(201).json(product);
    } catch (error) {
        console.error("PRODUCT ADD ERROR:", error);
        res.status(500).json({ message: "Unable to save product." });
    }
});

app.post("/api/products/reorder", requireAdmin, async (req, res) => {
    try {
        const productIds = Array.isArray(req.body?.productIds)
            ? req.body.productIds.map(x => String(x).trim()).filter(Boolean)
            : [];
        if (!productIds.length) return res.status(400).json({ message: "No product order received." });

        const uniqueIds = [...new Set(productIds)];
        const snapshot = await db.collection(COLLECTIONS.products).get();
        const existingIds = snapshot.docs.map(doc => doc.id);
        const existingSet = new Set(existingIds);
        if (uniqueIds.length !== existingIds.length || uniqueIds.some(id => !existingSet.has(id))) {
            return res.status(400).json({ message: "Product list changed. Please refresh and try again." });
        }

        await db.runTransaction(async tx => {
            for (let i = 0; i < uniqueIds.length; i++) {
                tx.update(db.collection(COLLECTIONS.products).doc(uniqueIds[i]), { order: i });
            }
        });

        res.json({ ok: true, products: await loadProducts() });
    } catch (error) {
        console.error("PRODUCT REORDER ERROR:", error);
        res.status(500).json({ message: "Unable to save product order." });
    }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
    try {
        const ref = db.collection(COLLECTIONS.products).doc(req.params.id);
        const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(404).json({ message: "Product not found." });

        const old = snapshot.data();
        const body = req.body || {};
        const updated = {
            ...old,
            icon: String(body.icon ?? old.icon ?? "📦").trim(),
            tag: String(body.tag ?? old.tag ?? "NEW").trim(),
            name: String(body.name ?? old.name ?? "").trim(),
            description: String(body.description ?? old.description ?? "").trim(),
            contentType: ["plans", "image", "both"].includes(body.contentType) ? body.contentType : (old.contentType || "plans"),
            imageUrl: String(body.imageUrl ?? old.imageUrl ?? "").trim(),
            downloadUrl: String(body.downloadUrl ?? old.downloadUrl ?? "").trim(),
            plans: Array.isArray(body.plans) ? normalizeProductPlans(body.plans, old.plans || []) : (old.plans || []),
            buttons: Array.isArray(body.buttons) && body.buttons.length
                ? body.buttons.slice(0, 2)
                : (old.buttons || [{ text: "GET PRODUCT", link: "#" }]),
            buyEnabled: typeof body.buyEnabled === "boolean" ? body.buyEnabled : Boolean(old.buyEnabled)
        };

        if (!updated.name) return res.status(400).json({ message: "Product name is required." });
        await ref.set(updated);
        res.json({ id: ref.id, ...updated });
    } catch (error) {
        console.error("PRODUCT UPDATE ERROR:", error);
        res.status(500).json({ message: "Unable to update product." });
    }
});

app.post("/api/products/:id/licenses/bulk", requireAdmin, async (req,res)=>{
 try{const ref=db.collection(COLLECTIONS.products).doc(req.params.id),keys=Array.isArray(req.body?.keys)?req.body.keys.map(x=>String(x).trim()).filter(Boolean):[],pi=Number(req.body?.planIndex);if(!Number.isInteger(pi)||pi<0)return res.status(400).json({message:"Invalid plan."});if(!keys.length)return res.status(400).json({message:"No license keys found."});
  const result=await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error("Product not found.");const data=snap.data(),plans=Array.isArray(data.plans)?data.plans.map(p=>({...p,licenses:Array.isArray(p?.licenses)?p.licenses.slice():[]})):[];if(!plans[pi])throw new Error("Selected plan is not available.");const seen=new Set(plans.flatMap(p=>p.licenses.map(x=>String(x).toLowerCase())));let added=0,duplicates=0;for(const key of keys){const k=key.toLowerCase();if(seen.has(k)){duplicates++;continue;}seen.add(k);plans[pi].licenses.push(key);added++;}tx.update(ref,{plans});return {added,duplicates,available:plans[pi].licenses.length};});res.json({ok:true,...result});
 }catch(error){console.error("LICENSE BULK ADD ERROR:",error);res.status(500).json({message:error.message||"Unable to import license keys."})}
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
    try {
        const ref = db.collection(COLLECTIONS.products).doc(req.params.id);
        const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(404).json({ message: "Product not found." });

        await ref.delete();
        res.json({ message: "Product deleted." });
    } catch (error) {
        console.error("PRODUCT DELETE ERROR:", error);
        res.status(500).json({ message: "Unable to delete product." });
    }
});



/* Razorpay webhook — production payment confirmation.
 * Dashboard event: payment.captured
 * The QR creation stores purchase_id in QR notes. Razorpay carries those notes
 * into the payment entity for QR payments, so the webhook can identify the
 * exact reserved purchase without guessing by amount/email.
 */
app.post("/api/webhooks/razorpay", async (req, res) => {
    try {
        if (!RAZORPAY_WEBHOOK_SECRET) {
            console.error("RAZORPAY WEBHOOK: secret is not configured.");
            return res.status(503).send("Webhook secret is not configured.");
        }

        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
        const signature = String(req.get("X-Razorpay-Signature") || "");
        const expected = crypto
            .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
            .update(rawBody)
            .digest("hex");

        const sigBuf = Buffer.from(signature, "utf8");
        const expBuf = Buffer.from(expected, "utf8");
        if (!signature || sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            console.warn("RAZORPAY WEBHOOK: invalid signature.");
            return res.status(401).send("Invalid signature.");
        }

        const eventId = String(req.get("x-razorpay-event-id") || "").trim();
        const payload = JSON.parse(rawBody.toString("utf8") || "{}");
        if (payload.event !== "payment.captured") return res.json({ ok: true, ignored: true });

        const payment = payload?.payload?.payment?.entity || {};
        const notes = payment.notes && typeof payment.notes === "object" ? payment.notes : {};
        const purchaseId = String(notes.purchase_id || "").trim();
        if (!purchaseId) {
            console.warn("RAZORPAY WEBHOOK: payment.captured has no purchase_id note.", payment.id);
            return res.status(202).json({ ok: true, ignored: true, reason: "purchase_id_missing" });
        }

        const ref = db.collection(COLLECTIONS.purchases).doc(purchaseId);
        let shouldDeliver = false;

        await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw new Error("Purchase not found.");
            const purchase = snap.data();
            if (purchase.status === "paid") return;

            const expectedAmount = Number(purchase.amountPaise || 0);
            const paidAmount = Number(payment.amount || 0);
            if (payment.status !== "captured" || !Number.isFinite(paidAmount) || paidAmount !== expectedAmount) {
                throw new Error("Captured payment does not match the purchase amount.");
            }

            tx.update(ref, {
                status: "paid",
                paymentId: String(payment.id || ""),
                webhookEventId: eventId || null,
                licenseKey: purchase.credentialMode === "license" ? (String(purchase.reservedLicenseKey || "").trim() || null) : null,
                account: purchase.credentialMode === "userpass" ? (purchase.reservedAccount || null) : null,
                downloadUrl: String(purchase.downloadUrl || "").trim(),
                paidAt: adminSdk.firestore.FieldValue.serverTimestamp(),
                paymentConfirmedBy: "razorpay_webhook"
            });
            shouldDeliver = true;
        });

        if (shouldDeliver) {
            try {
                await deliverPurchaseEmail(purchaseId);
            } catch (emailError) {
                console.error("RAZORPAY WEBHOOK DELIVERY EMAIL FAILED:", emailError);
            }
        }

        return res.json({ ok: true, received: true });
    } catch (error) {
        console.error("RAZORPAY WEBHOOK ERROR:", error);
        return res.status(500).json({ message: "Webhook processing failed." });
    }
});

/* Razorpay — customer-facing QR payment flow.
 * The amount is always read from the Firestore product on the server.
 */
app.post("/api/payment/test-success", async (req, res) => {
    if (!TEST_PAYMENT_ENABLED) {
        return res.status(404).json({ message: "Test payment is disabled." });
    }

    try {
        const productId = String(req.body?.productId || "").trim();
        const planIndex = Number(req.body?.planIndex);
        const customerName = String(req.body?.name || "").trim().slice(0, 120);
        const customerEmail = cleanEmail(req.body?.email);

        if (!productId || !Number.isInteger(planIndex) || planIndex < 0) {
            return res.status(400).json({ message: "Invalid product or package." });
        }
        if (customerName.length < 2) return res.status(400).json({ message: "Enter your name." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
            return res.status(400).json({ message: "Enter a valid email address." });
        }

        const product = await getDocument(COLLECTIONS.products, productId);
        if (!product) return res.status(404).json({ message: "Product not found." });
        const plans = Array.isArray(product.plans) ? product.plans : [];
        const selectedPlan = plans[planIndex];
        if (!selectedPlan) return res.status(400).json({ message: "Selected package is not available." });
        const amountPaise = parsePlanAmount(selectedPlan.price);
        if (!amountPaise) return res.status(400).json({ message: "This package does not have a valid numeric price." });

        const purchaseRef = db.collection(COLLECTIONS.purchases).doc();
        let reservedLicenseKey = "";
        let reservedAccount = null;
        let credentialMode = "license";

        await db.runTransaction(async tx => {
            const pref = db.collection(COLLECTIONS.products).doc(productId);
            const snap = await tx.get(pref);
            if (!snap.exists) throw new Error("Product not found.");
            const data = snap.data();
            const pp = Array.isArray(data.plans) ? data.plans.map(p => ({
                ...p,
                licenses: Array.isArray(p?.licenses) ? p.licenses.slice() : [],
                accounts: Array.isArray(p?.accounts) ? p.accounts.map(x => ({ ...x })) : []
            })) : [];
            const plan = pp[planIndex];
            if (!plan) throw new Error("Selected package is not available.");
            credentialMode = ["license", "userpass", "off"].includes(plan.credentialMode) ? plan.credentialMode : "license";
            if (credentialMode === "off") throw new Error("This plan is currently disabled.");
            if (credentialMode === "license") {
                if (!plan.licenses.length) throw new Error("This plan is currently out of stock.");
                reservedLicenseKey = String(plan.licenses.shift()).trim();
            } else if (credentialMode === "userpass") {
                if (!plan.accounts.length) throw new Error("This plan is currently out of stock.");
                reservedAccount = plan.accounts.shift();
            }
            tx.update(pref, { plans: pp });
        });

        const downloadUrl = String(product.downloadUrl || "").trim();
        await purchaseRef.set({
            productId,
            productName: String(product.name || ""),
            planIndex,
            planLabel: String(selectedPlan.label || `Package ${planIndex + 1}`),
            amountPaise,
            customerName,
            customerEmail,
            status: "paid",
            paymentId: `TEST_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
            licenseKey: credentialMode === "license" ? (reservedLicenseKey || null) : null,
            account: credentialMode === "userpass" ? reservedAccount : null,
            credentialMode,
            downloadUrl,
            testPayment: true,
            paidAt: adminSdk.firestore.FieldValue.serverTimestamp()
        });

        let emailStatus = "pending";
        try {
            const delivery = await deliverPurchaseEmail(purchaseRef.id);
            emailStatus = delivery.sent || delivery.alreadySent ? "sent" : (delivery.claimedByOther ? "sending" : "pending");
        } catch (emailError) {
            console.error("TEST PURCHASE DELIVERY EMAIL FAILED:", emailError);
            emailStatus = "failed";
        }

        return res.json({
            ok: true,
            testPayment: true,
            status: "paid",
            purchaseId: purchaseRef.id,
            amount: amountPaise / 100,
            productName: String(product.name || ""),
            planLabel: String(selectedPlan.label || ""),
            emailStatus,
            downloadUrl: downloadUrl || null
        });
    } catch (error) {
        console.error("TEST PAYMENT FAILED:", error);
        return res.status(400).json({ message: error.message || "Unable to complete test payment." });
    }
});

app.post("/api/payment/qr", async (req, res) => {
    try {
        const productId = String(req.body?.productId || "").trim();
        const planIndex = Number(req.body?.planIndex);
        const customerName = String(req.body?.name || "").trim().slice(0, 120);
        const customerEmail = cleanEmail(req.body?.email);

        if (!productId) return res.status(400).json({ message: "Product is required." });
        if (!Number.isInteger(planIndex) || planIndex < 0) {
            return res.status(400).json({ message: "Invalid package selected." });
        }
        if (customerName.length < 2) {
            return res.status(400).json({ message: "Enter your name." });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
            return res.status(400).json({ message: "Enter a valid email address." });
        }
        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
            return res.status(503).json({ message: "Razorpay payment service is not configured on the server." });
        }

        const product = await getDocument(COLLECTIONS.products, productId);
        if (!product) return res.status(404).json({ message: "Product not found." });

        const plans = Array.isArray(product.plans) ? product.plans : [];
        const selectedPlan = plans[planIndex];
        if (!selectedPlan) return res.status(400).json({ message: "Selected package is not available." });

        const amountPaise = parsePlanAmount(selectedPlan.price);
        if (!amountPaise) {
            return res.status(400).json({ message: "This package does not have a valid numeric price." });
        }

        const purchaseRef = db.collection(COLLECTIONS.purchases).doc();
        const purchaseId = purchaseRef.id;
        let reservedLicenseKey = ""; let reservedAccount = null; let credentialMode = "license";
        await db.runTransaction(async tx=>{const pref=db.collection(COLLECTIONS.products).doc(productId);const snap=await tx.get(pref);if(!snap.exists)throw new Error("Product not found.");const data=snap.data(),pp=Array.isArray(data.plans)?data.plans.map(p=>({...p,licenses:Array.isArray(p?.licenses)?p.licenses.slice():[],accounts:Array.isArray(p?.accounts)?p.accounts.map(x=>({...x})):[]})):[];const plan=pp[planIndex];if(!plan)throw new Error("Selected package is not available.");credentialMode=["license","userpass","off"].includes(plan.credentialMode)?plan.credentialMode:"license";if(credentialMode==="off")throw new Error("This plan is currently disabled.");if(credentialMode==="license"){if(!plan.licenses.length)throw new Error("This plan is currently out of stock.");reservedLicenseKey=String(plan.licenses.shift()).trim();}else if(credentialMode==="userpass"){if(!plan.accounts.length)throw new Error("This plan is currently out of stock.");reservedAccount=plan.accounts.shift();}tx.update(pref,{plans:pp});});
        const now = Date.now();
        const expiresAt = now + RAZORPAY_QR_TTL_SECONDS * 1000;
        const closeBy = Math.floor(expiresAt / 1000);

        await purchaseRef.set({
            productId,
            productName: String(product.name || ""),
            planIndex,
            planLabel: String(selectedPlan.label || `Package ${planIndex + 1}`),
            amountPaise,
            customerName,
            customerEmail,
            reservedLicenseKey,
            reservedAccount,
            credentialMode,
            downloadUrl: String(product.downloadUrl || "").trim(),
            status: "creating",
            createdAt: adminSdk.firestore.FieldValue.serverTimestamp(),
            expiresAt
        });

        try {
            const qr = await razorpayRequest("/payments/qr_codes", {
                method: "POST",
                body: JSON.stringify({
                    type: "upi_qr",
                    name: "GMC",
                    usage: "single_use",
                    fixed_amount: true,
                    payment_amount: amountPaise,
                    description: `${String(product.name || "GMC").slice(0, 70)} - ${String(selectedPlan.label || "").slice(0, 50)}`,
                    close_by: closeBy,
                    notes: {
                        purchase_id: purchaseId,
                        product_id: productId,
                        customer_email: customerEmail
                    }
                })
            });

            const qrImageUrl = String(qr.image_url || qr.short_url || "").trim();
            if (!qr.id || !qrImageUrl) {
                throw new Error("Razorpay did not return a QR image URL.");
            }

            await purchaseRef.update({
                status: "pending",
                razorpayQrId: qr.id,
                qrImageUrl,
                qrStatus: qr.status || "active",
                expiresAt
            });

            return res.json({
                ok: true,
                purchaseId,
                qrId: qr.id,
                qrImageUrl,
                amount: amountPaise / 100,
                amountPaise,
                productName: String(product.name || ""),
                planLabel: String(selectedPlan.label || ""),
                customerEmail,
                expiresAt
            });
        } catch (error) {
            await purchaseRef.update({status:"failed",error:String(error.message||"Unable to create Razorpay QR.")}).catch(()=>{});
            if(reservedLicenseKey || reservedAccount){await db.runTransaction(async tx=>{const prodRef=db.collection(COLLECTIONS.products).doc(productId),ps=await tx.get(prodRef);if(!ps.exists)return;const data=ps.data(),pp=Array.isArray(data.plans)?data.plans.map(p=>({...p,licenses:Array.isArray(p?.licenses)?p.licenses.slice():[],accounts:Array.isArray(p?.accounts)?p.accounts.map(x=>({...x})):[]})):[];const target=pp[planIndex];if(target){if(reservedLicenseKey&&!target.licenses.some(x=>String(x).toLowerCase()===reservedLicenseKey.toLowerCase()))target.licenses.push(reservedLicenseKey);if(reservedAccount&&!target.accounts.some(x=>String(x.username).toLowerCase()===String(reservedAccount.username).toLowerCase()))target.accounts.push(reservedAccount);}tx.update(prodRef,{plans:pp});}).catch(()=>{});}
            console.error("RAZORPAY QR CREATE FAILED:", error);
            return res.status(502).json({
                message: `Unable to create Razorpay QR: ${error.message || "Unknown Razorpay error."}`
            });
        }
    } catch (error) {
        console.error("PAYMENT QR REQUEST FAILED:", error);
        return res.status(500).json({ message: "Unable to start payment." });
    }
});

/* Return only the actual QR region from Razorpay's portrait QR poster.
 * The QR position is detected from the real returned image instead of using a
 * fixed CSS crop, so it remains readable across Razorpay image layouts.
 */
app.get("/api/payment/qr-image/:purchaseId", async (req, res) => {
    try {
        const purchaseId = String(req.params.purchaseId || "").trim();
        if (!purchaseId) return res.status(400).send("Purchase ID is required.");

        const snapshot = await db.collection(COLLECTIONS.purchases).doc(purchaseId).get();
        if (!snapshot.exists) return res.status(404).send("Payment session not found.");

        const purchase = snapshot.data();
        const sourceUrl = String(purchase.qrImageUrl || "").trim();
        if (!sourceUrl) return res.status(404).send("QR image is not ready.");

        const sourceResponse = await fetch(sourceUrl, {
            redirect: "follow",
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/*,*/*;q=0.8" }
        });
        if (!sourceResponse.ok) {
            return res.status(502).send(`Razorpay QR image request failed (${sourceResponse.status}).`);
        }

        const sourceBuffer = Buffer.from(await sourceResponse.arrayBuffer());
        const decoded = await sharp(sourceBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const { data, info } = decoded;

        const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
            inversionAttempts: "attemptBoth"
        });

        if (!code || !code.location) {
            // Fallback: return the original image if detection fails rather than
            // breaking the payment screen.
            res.setHeader("Cache-Control", "private, max-age=30");
            res.setHeader("Content-Type", sourceResponse.headers.get("content-type") || "image/png");
            return res.send(sourceBuffer);
        }

        const points = [
            code.location.topLeft,
            code.location.topRight,
            code.location.bottomLeft,
            code.location.bottomRight
        ];

        const xs = points.map(p => Number(p.x));
        const ys = points.map(p => Number(p.y));
        const minX = Math.max(0, Math.floor(Math.min(...xs) - 18));
        const minY = Math.max(0, Math.floor(Math.min(...ys) - 18));
        const maxX = Math.min(info.width, Math.ceil(Math.max(...xs) + 18));
        const maxY = Math.min(info.height, Math.ceil(Math.max(...ys) + 18));
        const width = maxX - minX;
        const height = maxY - minY;

        if (width < 80 || height < 80) {
            throw new Error("Detected QR region is too small.");
        }

        const cropped = await sharp(sourceBuffer)
            .extract({ left: minX, top: minY, width, height })
            .png()
            .toBuffer();

        res.setHeader("Cache-Control", "private, max-age=60");
        res.setHeader("Content-Type", "image/png");
        return res.send(cropped);
    } catch (error) {
        console.error("RAZORPAY QR IMAGE CROP FAILED:", error);
        return res.status(502).send("Unable to prepare the QR image.");
    }
});

app.get("/api/payment/qr/:purchaseId", async (req, res) => {
    try {
        const purchaseId = String(req.params.purchaseId || "").trim();
        if (!purchaseId) return res.status(400).json({ message: "Purchase ID is required." });

        const ref = db.collection(COLLECTIONS.purchases).doc(purchaseId);
        const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(404).json({ message: "Payment session not found." });

        const purchase = snapshot.data();
        if (purchase.status === "paid") {
            let emailStatus = purchase.deliveryEmailSentAt ? "sent" : (purchase.deliveryEmailStatus || "pending");
            if (!purchase.deliveryEmailSentAt) {
                try {
                    const delivery = await deliverPurchaseEmail(purchaseId);
                    emailStatus = delivery.sent || delivery.alreadySent ? "sent" : (delivery.claimedByOther ? "sending" : emailStatus);
                } catch (emailError) {
                    console.error("PURCHASE DELIVERY EMAIL FAILED:", emailError);
                    emailStatus = "failed";
                }
            }
            return res.json({ok:true,status:"paid",amount:Number(purchase.amountPaise||0)/100,productName:purchase.productName||"",planLabel:purchase.planLabel||"",paymentId:purchase.paymentId||null,downloadUrl:String(purchase.downloadUrl||"")||null,emailStatus});
        }

        if (Date.now() >= Number(purchase.expiresAt || 0)) {
            if(purchase.status!=="expired"){const reserved=String(purchase.reservedLicenseKey||"").trim(),account=purchase.reservedAccount||null;if(reserved||account){await db.runTransaction(async tx=>{const fresh=await tx.get(ref);if(!fresh.exists||fresh.data().status==="paid")return;const prodRef=db.collection(COLLECTIONS.products).doc(purchase.productId),ps=await tx.get(prodRef);if(!ps.exists)return;const data=ps.data(),pp=Array.isArray(data.plans)?data.plans.map(p=>({...p,licenses:Array.isArray(p?.licenses)?p.licenses.slice():[],accounts:Array.isArray(p?.accounts)?p.accounts.map(x=>({...x})):[]})):[];const target=pp[Number(purchase.planIndex)];if(target){if(reserved&&!target.licenses.some(x=>String(x).toLowerCase()===reserved.toLowerCase()))target.licenses.push(reserved);if(account&&!target.accounts.some(x=>String(x.username).toLowerCase()===String(account.username).toLowerCase()))target.accounts.push(account);}tx.update(prodRef,{plans:pp});tx.update(ref,{status:"expired",reservedLicenseKey:null,reservedAccount:null});}).catch(()=>{});}else await ref.update({status:"expired"}).catch(()=>{});}return res.json({ok:true,status:"expired"});
        }

        if (!purchase.razorpayQrId) {
            return res.status(409).json({ message: "Payment QR is not ready yet." });
        }

        const payments = await razorpayRequest(
            `/payments/qr_codes/${encodeURIComponent(purchase.razorpayQrId)}/payments?count=10`,
            { method: "GET" }
        );

        const items = Array.isArray(payments.items) ? payments.items : [];
        const captured = items.find(item =>
            item && item.status === "captured" &&
            Number(item.amount) === Number(purchase.amountPaise)
        );

        if (captured) {
            const licenseKey = String(purchase.reservedLicenseKey || "").trim();
            const account = purchase.reservedAccount && typeof purchase.reservedAccount === "object"
                ? { username: String(purchase.reservedAccount.username || "").trim(), password: String(purchase.reservedAccount.password || "") }
                : null;
            const mode = ["license", "userpass", "off"].includes(purchase.credentialMode)
                ? purchase.credentialMode
                : "license";
            const product = await getDocument(COLLECTIONS.products, purchase.productId);
            const downloadUrl = String(product?.downloadUrl || "").trim();
            await ref.update({
                status: "paid",
                paymentId: captured.id,
                licenseKey: mode === "license" ? (licenseKey || null) : null,
                account: mode === "userpass" ? account : null,
                credentialMode: mode,
                downloadUrl,
                paidAt: adminSdk.firestore.FieldValue.serverTimestamp()
            });

            let emailStatus = "pending";
            try {
                const delivery = await deliverPurchaseEmail(purchaseId);
                emailStatus = delivery.sent || delivery.alreadySent ? "sent" : (delivery.claimedByOther ? "sending" : "pending");
            } catch (emailError) {
                console.error("PURCHASE DELIVERY EMAIL FAILED:", emailError);
                emailStatus = "failed";
            }

            return res.json({
                ok: true,
                status: "paid",
                amount: Number(purchase.amountPaise || 0) / 100,
                productName: purchase.productName || "",
                planLabel: purchase.planLabel || "",
                paymentId: captured.id,
                downloadUrl: downloadUrl || null,
                emailStatus
            });
        }

        return res.json({
            ok: true,
            status: "pending",
            amount: Number(purchase.amountPaise || 0) / 100
        });
    } catch (error) {
        console.error("RAZORPAY QR STATUS FAILED:", error);
        return res.status(502).json({ message: `Unable to check payment: ${error.message || "Unknown error."}` });
    }
});

/* Google Drive image proxy */
function getGoogleDriveFileId(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        if (!host.includes("drive.google.com") && !host.includes("docs.google.com")) return null;

        const fileMatch = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (fileMatch) return fileMatch[1];

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
            textPart: `New contact message from GMC website

Name: ${name}
Email: ${email}
Contact No.: ${phone || "Not provided"}
Subject: ${subject}

Message:
${message}`,
            htmlPart: `<!doctype html>
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

async function startServer() {
    try {
        await seedFromJsonFiles();
        app.listen(PORT, () => {
            console.log(`GMC Admin server running on port ${PORT}`);
        });
    } catch (error) {
        console.error("FIREBASE STARTUP FAILED:", error);
        process.exit(1);
    }
}

startServer();
