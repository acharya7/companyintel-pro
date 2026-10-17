// Temporary diagnostic: prints the association fixture's real numbers.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { runIndex } from "./tools/indexer/src/build.ts";

const CSV1 = [
  "Company Name,Website,Country,City,Contact Name,Job Title,Email",
  "Delta Systems Limited,https://deltasystems.example,United States,Austin,Ada Lovelace,VP Engineering,ada.lovelace@deltasystems.example",
  "Delta Systems Pvt Ltd,https://deltasystems.in,India,Pune,Ravi Desai,Analyst,ravi.desai@deltasystems.in",
  "Delta Systems Limited,https://deltasystems.example,United States,Austin,Kyle Adams,Sales Director,kyle.adams@deltasystems.in",
  "Umbrella Group,https://umbrella.example,United States,Raccoon City,Alice Chen,Scientist,alice.chen@umbrella.example",
  "Acme Corporation,https://acme.example,United States,Detroit,John Smith,Plant Manager,john.smith@gmail.com",
].join("\n");

const CSV2 = [
  "organization,full_name,title,seniority,department,work_email,contact_country",
  "Delta Systems,Priya Menon,Engineer,Senior,Engineering,,India",
  "Delta Systems,Sam Allen,Engineer,Mid,Engineering,sam.allen@deltasystems.example,United States",
  "Delta Systems,Nina Patel,Director,Director,Sales,,United States",
  "Delta Systems,Omar Haddad,Analyst,Mid,Analytics,omar.haddad@contractor.example,United States",
  "Delta Systems,Leo Frank,Analyst,Mid,Analytics,,",
  "Delta Systems,Leo Frank,Analyst,Mid,Analytics,,",
  "Delta Systems,Gina Rossi,Engineer,Senior,Engineering,gina.rossi@deltasystems.in,Italy",
  "Delta Systems,Gina Rossi,Engineer,Senior,Engineering,gina.rossi@deltasystems.in,Italy",
  "Umbrella Group,Bob Lee,Analyst,Mid,Analytics,,United States",
  "Acme Corporation,Carol King,Vice President,Executive,Operations,carol.king@acme.example,United States",
  "Acme Corporation,Tina Brooks,Controller,Mid,Finance,,United States",
  "Acme Corporation,Tina Brooks,Analyst,Mid,Analytics,,United States",
].join("\n");

const root = mkdtempSync(join(tmpdir(), "probe-assoc-"));
const csv1 = join(root, "one.csv");
const csv2 = join(root, "two.csv");
writeFileSync(csv1, `${CSV1}\n`);
writeFileSync(csv2, `${CSV2}\n`);
const config = {
  datasetVersion: "probe-v1",
  sources: [
    { id: "csv1", path: csv1, encoding: "utf8", delimiter: "," },
    { id: "csv2", path: csv2, encoding: "utf8", delimiter: "," },
  ],
  workDir: join(root, "work"),
  outputDir: join(root, "out"),
  partitions: 8,
  shards: { exact: 8, prefix: 8, token: 8, trigram: 8, ids: 8 },
};
const result = await runIndex(config, {});
console.log("COUNTERS", JSON.stringify(result.counters, null, 1));
console.log("DIRECTORY", JSON.stringify({ ...result.directory, createdAt: "-" }));

const read = async (key) => JSON.parse(gunzipSync((await import("node:fs")).readFileSync(join(config.outputDir, key))).toString("utf8"));
for (const object of result.objects) {
  if (object.key.startsWith("companies/")) {
    const payload = await read(object.key);
    for (const company of payload.companies) {
      console.log(
        "COMPANY",
        company.name,
        "|",
        company.id,
        "| domain",
        company.domain,
        "| ambiguous",
        Boolean(company.ambiguous),
        "| count",
        company.contactCount,
        "| assoc",
        JSON.stringify(company.associations),
      );
    }
  }
  if (object.key.startsWith("contacts/")) {
    const payload = await read(object.key);
    for (const [ref, contacts] of Object.entries(payload.byCompany)) {
      for (const contact of contacts) {
        console.log("CONTACT", ref, contact.fullName, "|", contact.association?.category, "|", contact.association?.reason, "|", contact.email ?? "-", "|", contact.companyId);
      }
    }
  }
  if (object.key.startsWith("unassigned/")) {
    const payload = await read(object.key);
    console.log("UNASSIGNED", object.key, JSON.stringify(payload.contacts.map((c) => ({ name: c.fullName, claimed: c.claimedCompanyName, normalized: c.claimedNormalizedName, cat: c.association.category, id: c.id }))));
  }
}
