# SolmentoAI backend

This is the only place for Express, MySQL, authentication, JWT, database schema, migrations/setup and seed code. The React application remains in the repository root `src/` and communicates with this service over HTTP. Do not put server, database or secret code in `src/`.

## Run

```powershell
Copy-Item .env.example .env
# Fill MYSQL_* and separate random JWT_SECRET and SUPER_ADMIN_JWT_SECRET values in backend/.env
cd backend
npm install
npm run schema
npm run seed
npm run dev
```

The API listens on `http://localhost:5000`. The frontend expects `VITE_API_URL=http://localhost:5000/api` in a root `.env.local` file. CORS allows both Vite ports `5173` and `5174` by default; set `FRONTEND_ORIGINS` when using another port.

Development users are created by `npm run seed`:

| Role | Email | Password source |
| --- | --- | --- |
| SUPER_ADMIN | value of `SEED_SUPER_ADMIN_EMAIL` | `SEED_SUPER_ADMIN_PASSWORD` in ignored `backend/.env` |
| ADMIN | value of `SEED_ADMIN_EMAIL` | `SEED_ADMIN_PASSWORD` in ignored `backend/.env` |
| HEAD_COUNSELLOR | value of `SEED_HEAD_COUNSELLOR_EMAIL` | `SEED_HEAD_COUNSELLOR_PASSWORD` in ignored `backend/.env` |
| COUNSELLOR | value of `SEED_COUNSELLOR_EMAIL` | `SEED_COUNSELLOR_PASSWORD` in ignored `backend/.env` |

Change seed passwords before production use. Admin/Tenant authentication uses `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/verify-email/:token`, `POST /api/auth/logout`, and `GET /api/auth/me`. Super Admin authentication is separate: `POST /api/auth/superadmin/login`, `POST /api/auth/superadmin/logout`, and `GET /api/auth/superadmin/me`. The two realms use different HTTP-only cookies and JWT audiences/secrets; password hashes are never returned.

Account management is role protected: `POST /api/superadmin/admins` and `GET /api/superadmin/admins` are SUPER_ADMIN-only; `POST /api/admin/team-members` and `GET /api/admin/team-members` are ADMIN-only and scoped to the authenticated admin's tenant. Public onboarding always creates a tenant and its first ADMIN; it cannot create SUPER_ADMIN. The login selector is visual only; the backend derives the role from MySQL.

Super Admin tenant and platform management APIs include `GET/PATCH /api/superadmin/tenants/:id`, `GET /api/superadmin/tenants`, `GET/POST/PATCH /api/superadmin/plans`, `GET /api/superadmin/audit-logs`, and authenticated module records under `/api/superadmin/modules/:module`. Run `npm run schema` after pulling migrations; the setup is additive and preserves existing rows.
