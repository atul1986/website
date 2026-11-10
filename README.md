# atul-sir.onrender.com — website v2

Your academic website, now with a visitor database, a chatbot, a private visitor dashboard and research figures that update themselves every day.

## What's inside

| File | What it is |
|---|---|
| `server.js` | The website server (Node.js). Records visits, runs the chatbot, updates Scholar data, serves `/admin`. |
| `public/index.html` | The website itself. |
| `public/admin.html` | Your private visitor dashboard at `/admin`. |
| `public/gallery/` | Achievement images (certificate, Elsevier reviewer rewards). Add more here. |
| `announcements.json` | The "Upcoming" news bar. Edit, commit, done. |
| `chatbot-knowledge.md` | What the chatbot knows about you. Edit to teach it new facts. |

**Before you deploy, copy these from your current site into `public/`:** `atulsir-bio.jpeg` (your photo), `books.html` and `hpc.html`.

## Deploy on Render (about 10 minutes)

1. Put this folder in a GitHub repository (e.g. `atul-sir-website`).
2. In Render, open your existing **atul-sir** service → **Settings**, point it to the new repository, and set:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`

   (If your current service is a *Static Site*, create a new **Web Service** instead, then move the `atul-sir` name/custom domain to it.)
3. Go to **Environment** and add:

| Variable | Needed? | What to put |
|---|---|---|
| `ADMIN_KEY` | **Yes** | Any long password you choose. You'll type it at `/admin`. |
| `MONGODB_URI` | **Strongly recommended** | Free database from [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) (M0 free cluster → Connect → Drivers → copy the string). Without it, Render's free plan erases visitor history every time the site redeploys. |
| `SERPAPI_KEY` | Recommended | Free key from [serpapi.com](https://serpapi.com) (100 searches/month; the site uses ~30). Gives exact Google Scholar citations, h-index, i10 and yearly chart, refreshed daily. |
| `OPENALEX_KEY` | Optional | Free key from [openalex.org/settings/api](https://openalex.org/settings/api). Used when there's no SerpApi key — adds newly published papers automatically. |
| `ANTHROPIC_API_KEY` | Optional | From [console.anthropic.com](https://console.anthropic.com). Lets the chatbot answer any question in natural language. Without it, the built-in assistant still answers common questions. |
| `NAME_VARIANTS` | Optional | Comma-separated spellings of your name for the Google sync. Default: Atul Kathole, Dr. Atul Kathole, Dr. Atul B. Kathole, Atul B. Kathole, Atul Baliram Kathole, Dr. Atul Baliram Kathole. |
| `GOOGLE_API_KEY` | Optional | Google Books API key, only if you hit Google's free daily limit. |
| `IP_SALT` | Optional | Any random text. |

4. Click **Manual Deploy → Deploy latest commit**. Open `https://atul-sir.onrender.com/admin` and enter your `ADMIN_KEY`.

## How the pieces work

- **Visitor database:** every visit records date/time, approximate city and country, internet provider, device, OS, browser, screen size, language, where they came from (Google, LinkedIn…), how long they stayed, how far they scrolled and which sections they viewed. Full IP addresses are never stored (the last part is hidden), and the footer tells visitors this. Bots are ignored.
- **Dashboard (`/admin`):** totals, unique visitors, today, online now, average time, daily chart, countries, cities, referrers, devices, recent visits, every chatbot question, CSV download, and an "Update Scholar data now" button.
- **Google Scholar auto-update:** once a day the server refreshes citations, h-index, i10-index, the yearly chart and new papers. Google doesn't allow Scholar pages to be scraped directly, so the licensed SerpApi route is used for exact Scholar numbers; OpenAlex (open data) is the free fallback for new papers. The page always keeps your last good numbers.
- **Google sync (daily, all name spellings):** Google Books adds any new book you edit or write to the Books shelf (published or upcoming); Google News fills the "In the news" section and the top bar; Crossref adds new papers and chapters with a DOI. Results are kept in `data/websync.json`.
- **Instagram:** add post links to `CONFIG.instagramPosts` in `index.html`; the newest one is embedded in "In the news".
- **Old links still work:** `/bio`, `/patents`, `/publications`, `/contact` etc. now jump to the matching section.

## Everyday edits

- **News bar:** edit `announcements.json`.
- **New achievement:** add the image to `public/gallery/`, then copy one `<figure class="g-card"…>` block in the Recognition section of `index.html`.
- **Your email:** set `CONFIG.email` near the top of the script in `index.html` (contact form, project enquiries and contact card use it).
- **Chatbot facts:** edit `chatbot-knowledge.md` (AI mode) and the `INTENTS` list in `index.html` (built-in mode).

## Run locally

```bash
npm install
ADMIN_KEY=test npm start   # then open http://localhost:3000 and http://localhost:3000/admin
```
