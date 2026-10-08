import { parseStoreRows } from "../lib/store-list.mjs";

const samples = [
  ["DE", "https://www.amazon.de/sp?seller=A1B2C3D4E5F6G7"],
  ["UK", "https://www.amazon.co.uk/sp?seller=A1B2C3D4E5F6G7"],
  ["CA", "https://www.amazon.ca/sp?seller=A1B2C3D4E5F6G7"],
  ["MX", "https://www.amazon.com.mx/sp?seller=A1B2C3D4E5F6G7"],
  ["BR", "https://www.amazon.com.br/sp?seller=A1B2C3D4E5F6G7"],
  ["PL", "https://www.amazon.pl/sp?seller=A1B2C3D4E5F6G7"],
  ["FR", "https://www.amazon.fr/sp?seller=A1B2C3D4E5F6G7"],
  ["IT", "https://www.amazon.it/sp?seller=A1B2C3D4E5F6G7"],
  ["ES", "https://www.amazon.es/sp?seller=A1B2C3D4E5F6G7"],
];

let failed = 0;
for (const [market, url] of samples) {
  const result = parseStoreRows([[url]], { marketplace: market });
  const first = result.stores?.[0];
  const rejected = result.rejectedRows?.[0];
  const ok = !rejected && first && !first.importBlocked;
  if (!ok) failed += 1;
  console.log(`${market}: ${ok ? "OK" : `REJECTED ${rejected?.code || "unknown"}`}`);
}
console.log(failed === 0 ? "ALL MARKETS PASS" : `${failed} FAILED`);
