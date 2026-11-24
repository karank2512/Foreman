/**
 * `npm run user:reset-link -- <email>` — a one-time password-reset link for any account, for whoever runs the
 * server. It exists for the case the app can't cover by itself: the only owner of a workspace forgot their
 * password, so nobody can make them a link from Settings → Members.
 *
 * On Docker the image carries it bundled (it reads the same generated AUTH_SECRET as the app):
 *   docker compose run --rm --no-deps web node dist/reset-password-link.cjs you@example.com
 *
 * Making a link signs that person out everywhere and retires any earlier link. Nothing is sent anywhere: the
 * link is printed here for you to open or pass on. Needs the database and the app's AUTH_SECRET; spends nothing.
 */

// Both are pure (no database, no environment), so importing them up front is safe before .env is loaded.
import { errorMessage, isAppError } from "@/server/errors";
import { redactSecrets } from "@/server/security/redact";

const USAGE = "Usage: npm run user:reset-link -- <email>";

/** .env the way the app loads it (existing variables win). dotenv is a dev dependency, absent from the image. */
async function loadDotenv(): Promise<void> {
  try {
    (await import("dotenv")).config({ quiet: true });
  } catch {
    // Not installed: the runtime image, where compose has already put .env into the environment.
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h" || !args[0].includes("@")) {
    console.error(USAGE);
    return args[0] === "--help" || args[0] === "-h" ? 0 : 2;
  }

  await loadDotenv();
  // Imported only now, so the database client sees the DATABASE_URL that .env just provided.
  const { createPasswordResetLinkForOperator } = await import("@/server/account");
  const { db } = await import("@/server/db");

  try {
    const link = await createPasswordResetLinkForOperator(args[0]);
    console.log(`Reset link for ${args[0]} (${link.organizationName}):`);
    console.log("");
    console.log(`  ${link.resetUrl}`);
    console.log("");
    console.log(`It works once, until ${link.expiresAt} (UTC). They have been signed out everywhere.`);
    console.log("Anyone with this link can set the password, so pass it on only to the account's owner.");
    return 0;
  } catch (e) {
    // A database error can carry connection details; print it scrubbed, like everything else Foreman logs.
    console.error(isAppError(e) ? e.message : `Could not make a reset link: ${redactSecrets(errorMessage(e))}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Reached only if an import or the disconnect itself fails; scrubbed like every other error this prints.
    console.error(`Could not make a reset link: ${redactSecrets(errorMessage(e))}`);
    process.exitCode = 1;
  },
);
