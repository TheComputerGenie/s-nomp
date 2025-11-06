// Utility helpers used across pool worker modules
// Currently contains a robust environment JSON parser used to safely
// parse JSON strings passed through environment variables (often via
// cluster.fork or external process managers). This is intentionally
// lightweight and dependency-free so it can be required anywhere.

function safeParseEnvJSON(name) {
    const raw = process.env[name];
    if (typeof raw === 'undefined') {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    // Fast path: valid JSON
    try {
        return JSON.parse(raw); 
    } catch (e) { /* fall through */ }

    // If first parse fails, it may be double-encoded: JSON.stringify was
    // applied twice, so parsing once yields a JSON string. Try parsing twice.
    try {
        const once = JSON.parse(raw);
        if (typeof once === 'string') {
            return JSON.parse(once);
        }
    } catch (e) { /* fall through */ }

    // Try unwrapping a quoted string and unescaping common escape sequences
    try {
        let attempt = raw;
        if (attempt.length > 1 && attempt[0] === '"' && attempt[attempt.length - 1] === '"') {
            attempt = attempt.slice(1, -1);
        }
        // Replace escaped quotes and escaped newlines which commonly appear
        // when environment values are serialized into other JSON containers.
        attempt = attempt.replace(/\\"/g, '"').replace(/\\n/g, '\n');
        return JSON.parse(attempt);
    } catch (e) {
        const sample = String(process.env[name]).slice(0, 240).replace(/\n/g, '\\n');
        throw new Error(`Failed to parse environment JSON for ${name}. sample=${sample} parseError=${e && e.message ? e.message : String(e)}`);
    }
}

module.exports = {
    safeParseEnvJSON
};
