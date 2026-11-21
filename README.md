# silho

Minimalist digital wardrobe, cost-per-wear ledger, and virtual fit studio.

## Stack

- **Framework:** Next.js (App Router, TypeScript)
- **Styling:** Tailwind CSS + `lucide-react`
- **Database:** Neon PostgreSQL + Drizzle ORM (`drizzle-orm/neon-http`)
- **Authentication:** Better Auth (email/password + Drizzle adapter)
- **Client-Side Cutouts:** `@imgly/background-removal` (WASM/ONNX in browser)
- **AI Virtual Try-On:** CatVTON via Hugging Face Spaces (`@gradio/client`) + `sharp`

## Local Setup

1. Copy `.env.local.example` to `.env.local` and configure `DATABASE_URL` and `BETTER_AUTH_SECRET`.
2. Push schema to Neon:
   ```bash
   npx drizzle-kit push
   ```
3. Run development server:
   ```bash
   npm run dev
   ```
