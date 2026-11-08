# src/oracle — salinan terversi dari `oracle-tee`

Sumber: repo `oracle-tee` commit `21ddaeb` (`src/redact.ts`, `src/pipeline.ts`, `src/enclave-client.ts`).
Backend dideploy dari clone repo ini saja (0 dependency runtime), jadi `oracle-tee` tidak bisa diimpor
sebagai paket; berkas disalin **tanpa perubahan** kecuali:

- `enclave-client.ts`: bagian `RES-101` (jalur `@nearai/inference-sdk`) dibuang — butuh dependency
  runtime yang backend sengaja tidak punya. Jalur HTTP langsung (`runGenomeExperiment`) tetap
  memverifikasi `signed_text` + ed25519 secara lokal.

`test/oracle-sync.test.ts` membandingkan salinan ini dengan `../oracle-tee/src` bila repo itu ada di
sebelah (otomatis dilewati di clone tunggal) agar drift ketahuan. Jangan edit berkas di sini; ubah di
`oracle-tee` lalu salin ulang dan perbarui hash di atas.
