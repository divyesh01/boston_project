async function probe() {
  console.log("Probing backend endpoint /api/functions/aiAssistant for error exposure...");

  try {
    // Send malformed JSON to trigger an internal SyntaxError inside the function
    const res = await fetch("http://localhost:5173/api/functions/aiAssistant", {
      method: "POST",
      body: "{ this is invalid json ]"
    });

    const text = await res.text();
    console.log(`\nResponse Body:\n${text}\n`);

    // The vulnerability: returning `error.message` directly from catch(e) exposes internal system messages
    if (text.includes("SyntaxError") || text.includes("Unexpected token") || text.includes("Unexpected string")) {
      console.error("❌ PROBE FAILED (Code 1): Sensitive internal error details were successfully retrieved by the client.");
      process.exit(1);
    } else {
      console.log("✅ PROBE PASSED: Internal error details were properly sanitized.");
      process.exit(0);
    }
  } catch (err) {
    console.error("Network error (is the dev server running?):", err.message);
    process.exit(1);
  }
}

probe();
