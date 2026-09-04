# syntax=docker/dockerfile:1

# --- build -------------------------------------------------------------------
# Also the image the migrate service runs from: drizzle-kit, drizzle.config.ts
# and the SQL files all live here, and none of them survive into the runtime
# stage. Running migrations out of a stage that already exists costs nothing;
# `npx drizzle-kit` in the runtime image would mean a network fetch at deploy
# time and a config file that is not there.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

# pnpm-workspace.yaml is not optional. It carries the @better-auth/utils
# override, and without it pnpm resolves 0.5.0 for an unmet peer and installs a
# second copy of @better-auth/core — which keeps working at runtime while every
# auth.api.* call becomes a type error.
#
# The source is copied before install rather than after because the postinstall
# hook is `nuxt prepare`, which needs nuxt.config.ts and app/ to exist.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# --- runtime -----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

# /data/state is created here, owned by the unprivileged user, so that a named
# volume mounted over it inherits that ownership. Docker seeds an empty named
# volume from the image path; created at mount time instead it would belong to
# root and every state write would fail with EACCES.
RUN addgroup -S app \
  && adduser -S app -G app \
  && mkdir -p /data/state \
  && chown -R app:app /data/state

COPY --from=build --chown=app:app /app/.output ./.output
COPY --from=build --chown=app:app /app/package.json ./

USER app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
