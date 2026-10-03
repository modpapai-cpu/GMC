# GMC Vercel Deployment

## 1. Deploy this folder as the Vercel project root
Use the folder containing `package.json`, `server.js`, `api/`, `public/` and `vercel.json`.

## 2. Required Vercel Environment Variables
Set these in Vercel -> Project Settings -> Environment Variables:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

Or set the single variable:

- `FIREBASE_SERVICE_ACCOUNT_JSON`

If using Mailjet/contact email features, keep the existing Mailjet variables from your current deployment as well.

## 3. Important API test
After deployment open:

`https://YOUR-DOMAIN/api/plugin-license/verify?key=GMC-TEST`

A working deployment should return JSON similar to:

`{"valid":false,"message":"License key not found."}`

A **404 HTML page is not expected**.

## 4. Admin Plugin License Manager
Open the admin dashboard after logging in. The Plugin License Manager is below Reseller Manager.

## 5. PowerShell installer
The included `install.ps1` is configured for:

`https://gmc-tau.vercel.app`

If the production domain changes, update `$GmcApiBase` in `install.ps1`.
