# Mayank Saini — VLSI Portfolio

A responsive, multi-page portfolio built with plain HTML, CSS, and JavaScript. No build step is required. Existing profile, certificate, event, and resume assets are retained. The previous Notes section and notes files have been removed.

## Pages

- `index.html` — Home, highlights, and the four-card My Resumes library
- `about.html`, `education.html`, `experience.html`, `skills.html`
- `projects.html` — portfolio projects and public GitHub projects
- `pages/projects/` — individual project details
- `certifications.html`, `gallery.html`, `roadmap.html`
- `contact.html` — email-client fallback or configured email-delivery function

Shared site styling is in `css/style.css`. Common interactions are in `js/main.js`, and contact form logic is maintained separately in `js/contact.js`.

## Preview

Open the folder in VS Code and use a local HTTP server such as the Live Server extension. The public portfolio pages work without backend credentials.

## Source and deployment access
Supabase RLS protects database operations; it does not control GitHub source access or hosting-account permissions.

## Contact delivery

Without an endpoint, the contact form opens the visitor's email application and explicitly says the message has not been sent by the website.

For server-side email delivery, deploy `supabase/functions/contact-message/` as a Supabase Edge Function with Resend:

1. Verify a sender domain in Resend.
2. Set `RESEND_API_KEY`, `CONTACT_FROM_EMAIL`, optional `CONTACT_TO_EMAIL`, `CONTACT_RATE_LIMIT_SALT`, and a comma-separated `CONTACT_ALLOWED_ORIGINS` using Supabase Function secrets. The salt and service-role key remain server-only; do not put them in `backend/config.js`.
3. Deploy the function and set `window.__CONTACT_ENDPOINT__` to its HTTPS URL in `backend/config.js`.
4. The page reports success only if the function receives an accepted message ID from the email provider. Errors remain visible and the form is not cleared.

The function validates input, limits field lengths, checks the request origin, includes a honeypot, applies a database-backed limit of five requests per address per 15 minutes using a salted address hash, and always delivers to the configured owner address rather than a user-supplied recipient.

## Resume and source accuracy

The homepage's **My Resumes** section links to four original PDFs in the project root: `Mayank_Saini_Resume.pdf`, `MAYANK N.pdf`, `Mayank_QA_Testing_Intern_Resume.pdf`, and `VLSI frontend developer.pdf`. The first two are closely related VLSI-focused versions with different stated role headers; the other two are tailored to QA testing and VLSI front-end roles. All four original files remain unchanged. Project details are based on the existing portfolio and public repositories. The additional GitHub projects are:

- [CHIPVERSE](https://github.com/mayanksani3412/CHIPVERSE)
- [Parameterized Verilog adder](https://github.com/mayanksani3412/verilog-full-adder-or-n-bit-adder-verilog)
- [Neon Highway — Car Racing Game](https://github.com/mayanksani3412/Car-Racing-Game)

LinkedIn blocked automated access during preparation, so no additional claims were sourced from it. Project visuals that are not real project screenshots are labeled as illustrations. Planned roadmap items are not presented as completed skills.

## Search engine setup

Before deploying, replace `SITE-URL-REQUIRED.example` in `sitemap.xml` with the final HTTPS origin and add the matching Sitemap URL to `robots.txt`. The final hosting domain was not available when this project was prepared.

