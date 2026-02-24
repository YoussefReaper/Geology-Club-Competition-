// Local development server — wraps the API app and serves static files
const express = require("express");
const path = require("path");
const apiApp = require("./api/index");

const app = express();

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// Mount API routes
app.use(apiApp);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GCC Server running at http://localhost:${PORT}`);
});
