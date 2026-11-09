# Manual GitHub Instructions

The coding agent did **not** create a repository, commit, or push. These are the
exact commands for you to run manually after reviewing the project.

## 1. Before the first commit

Confirm that secrets and local artifacts are ignored:

```cmd
git status --short
git check-ignore -v .env
git check-ignore -v backups
```

Expected: `.env` and `backups` are ignored. If `.env` appears in `git status`, stop
and fix `.gitignore` before committing.

Do a quick secret check (optional but recommended):

```cmd
git grep -n -I -E "(POSTGRES_ADMIN_PASSWORD|AWS_DB_PASSWORD|RENDER_DB_PASSWORD|REDIS_PASSWORD|CACHE_API_KEY|CONTROL_PLANE_ADMIN_TOKEN|CONTROL_PLANE_SERVICE_TOKEN|CONTROL_PLANE_READ_TOKEN|AWS_TO_RENDER_HMAC_SECRET|RENDER_TO_AWS_HMAC_SECRET|RENDER_SUPERVISOR_TOKEN)="
```

This only lists variable names and assignments. Make sure no real value appears. The
tracked `.env.example` must contain only `__GENERATE__` placeholders.

Also confirm that `tests/integration/reports/`, `node_modules/`, logs, certificates,
and backups are not staged.

## 2. Initialize the repository

From the project root:

```cmd
git init
git branch -M main
git add .
git status
```

Review the staged file list carefully. Then commit:

```cmd
git commit -m "Initial commit: multi-cloud service mesh data plane sidecar"
```

## 3. Create the GitHub repository

1. Open <https://github.com/new>.
2. Choose a repository name, for example `MultiCloud-Service-Mesh`.
3. Choose **Public** or **Private**. Both are free.
4. Do **not** initialize with a README, `.gitignore`, or license, because the local
   project already has them.
5. Create the repository.

## 4. Add the remote and push

Replace `<your-account>` and `<your-repo>`:

```cmd
git remote add origin https://github.com/<your-account>/<your-repo>.git
git push -u origin main
```

If GitHub asks for a password, use a personal access token or GitHub Desktop. Do not
paste tokens into shared documents or logs.

## 5. Recommended repository settings

- Keep the repository private if you are unsure about any data.
- Add a short description: "Multi-cloud service mesh with independent data-plane
  sidecars, AWS Academy EC2 + Render Free."
- Add topics such as `nodejs`, `express`, `docker`, `microservices`, `service-mesh`.
- Do not enable paid features or GitHub Actions minutes beyond the free allowance.
- Do not commit real deployment secrets later.

## 6. Subsequent commits

```cmd
git status
git add <files>
git commit -m "Describe the change"
git push
```

Avoid `git add -A` without checking `git status` first, especially after generating
backups or local reports.

## 7. If a secret was committed by mistake

1. Rotate the secret immediately (generate a new one and update the deployment).
2. Remove it from the repository history. Rewriting history is destructive; ask for
   help if you are unsure.
3. Force-push only if you understand the impact on collaborators.
4. Recreate affected database users/volumes if database passwords were exposed.

The safest approach is to keep `.env` untracked from the beginning.

## 8. What the agent will not do

- Log in to GitHub
- Create the repository
- Commit or push
- Create deploy keys or tokens
- Access any cloud account
- Deploy the project

All of the above remain manual user actions.
