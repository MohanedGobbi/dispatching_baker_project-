# CrewBoard manual

`index.html` is the user manual (open it in a browser; screenshots are in `img/`). `CrewBoard-manual.pdf` is the same thing as a PDF.

## Regenerating the screenshots

After a UI change, retake them from the running app on a freshly seeded demo database:

```bash
cd apps/api && npm run seed && npm run demo     # API must be running (npm run start:dev)
cd ../web && npm run dev                         # web app on :5173
npx playwright test -c playwright.manual.config.ts   # set PW_CHANNEL=chrome to use installed Chrome
```

The script is `apps/web/e2e-manual/shots.spec.ts`. It skips (and prints) any screen it cannot reach, so check the output. `10-board-top.png` and `10-board-units.png` are crops of the full-page `10-board.png` (`ffmpeg -vf crop=1366:1250:0:0` and `crop=1366:1050:0:1700`).

## Making the PDF

Open `index.html` in Chrome and print to PDF (the print stylesheet hides the contents bar and starts each chapter on a new page), or from a shell:

```bash
chrome --headless --print-to-pdf=docs/manual/CrewBoard-manual.pdf --no-pdf-header-footer docs/manual/index.html
```
