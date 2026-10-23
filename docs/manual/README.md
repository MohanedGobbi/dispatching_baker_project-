# CrewBoard manual

`index.html` is the user manual (open it in a browser; screenshots are in `img/`). `CrewBoard-manual.pdf` is the same thing as a PDF.

## Regenerating the screenshots (and the demo video)

After a UI change, retake them from the built app on a **throwaway** database with the demo story (never the real data;
see the main README). In PowerShell, from the repository root:

```powershell
$env:DATA_DIR = 'C:\temp\crewboard-shots'
npm run build
cd apps/api; npm run seed
Start-Process node -ArgumentList 'dist\src\main.js' -WindowStyle Hidden    # the app on http://127.0.0.1:3000
npm run demo
cd ../web
$env:PW_CHANNEL = 'msedge'                       # or 'chrome': use an installed browser
npx playwright test -c playwright.manual.config.ts shots        # the screenshots in docs/manual/img
$env:DEMO_VIDEO = '1'; npx playwright test -c playwright.manual.config.ts demo-video   # the demo video (needs ffmpeg to make an mp4)
```

The scripts are `apps/web/e2e-manual/shots.spec.ts` and `demo-video.spec.ts`. The screenshot script skips (and prints) any
screen it cannot reach, so check the output.

## Making the PDF

Print `index.html` to PDF (the print stylesheet hides the contents bar and starts each chapter on a new page), for example
with Edge or Chrome from a shell:

```bash
msedge --headless=new --print-to-pdf=docs/manual/CrewBoard-manual.pdf --no-pdf-header-footer docs/manual/index.html
```
