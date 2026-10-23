const names = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GIT_TOKEN",
  "VLY_TOKEN",
  "VLY_API_KEY",
  "VLY_GITHUB_TOKEN",
  "VLY_INTEGRATION_TOKEN",
  "CLOUDFLARE_API_TOKEN",
];
console.log(
  JSON.stringify(
    Object.fromEntries(
      names.map((name) => [name, { present: Boolean(process.env[name]), length: String(process.env[name] ?? "").length }]),
    ),
    null,
    1,
  ),
);
