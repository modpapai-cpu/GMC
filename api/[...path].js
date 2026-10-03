// Vercel catch-all API function.
// This makes /api/plugin-license/* and the other Express API routes
// resolve to the same Express application on Vercel.
module.exports = require('../server');
