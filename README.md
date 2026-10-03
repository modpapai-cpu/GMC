# GMC v8 — plans/image content switch

Base: GMC v8.

Product content can be either PLANS & PRICES or IMAGE. When IMAGE is selected, the image URL is saved as `imageUrl` and displayed in the same content/pricing area on the product page. The admin product list also shows the selected image.

Run:
`npm install`
`npm start`

Admin: `/admin.html`
Products: `/product.html`


### Google Drive images
1. Upload the image to Google Drive.
2. Right-click it → Share.
3. Under General access choose **Anyone with the link** and **Viewer**.
4. Copy the sharing link and paste it into the product IMAGE field.
The server converts common Drive links (`/file/d/.../view`, `open?id=...`, `uc?id=...`) to a Drive download URL automatically.

## GMC Plugin License System

This version includes a Firestore-backed plugin license system.

- Admin Dashboard → Plugin Manager controls enabled GMC plugins.
- Admin can generate random plugin license keys directly.
- Product Manager can create a `PLUGIN LICENSE PRODUCT` and assign plugins + validity to each plan.
- Normal visitors do not receive plugin-license products from `/api/products`.
- Resellers assigned to a plugin-license product can generate a fresh key through the existing reseller bypass flow.
- Validity is stored server-side; `0` means lifetime.
- The PowerShell installer accepts an optional key. ENTER installs Vencord without GMC plugins; a valid key installs only its assigned plugins.
- The installer verifies keys against `/api/plugin-license/verify` and no longer uses Pastebin plugin configuration.

### PowerShell API URL

Open `install.ps1` and set `$GmcApiBase` to the final HTTPS domain of this GMC website before distributing the installer.
