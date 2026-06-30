// Seed entrypoint — placeholder. Implemented by a downstream worker per SPEC.md.
// Intended to seed SystemSetting defaults and a few demo prospects/companies.
async function main(): Promise<void> {
  // no-op for now
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
