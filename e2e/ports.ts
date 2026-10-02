// Where the e2e client and server run. The defaults are used by `pnpm e2e`; a second run alongside
// it (for example just the specs that failed) sets E2E_CLIENT_PORT, E2E_API_PORT and, to keep its own
// database, E2E_STATE, so the two share no server, port or state:
//   E2E_CLIENT_PORT=5274 E2E_API_PORT=3102 E2E_STATE=e2e/.state-2 pnpm e2e <paths> --output=e2e/.results-2

export const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 5273);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
/** The throwaway wrangler state folder, relative to the repository root. */
export const STATE = process.env.E2E_STATE ?? 'e2e/.state';
export const CLIENT_ORIGIN = `http://localhost:${CLIENT_PORT}`;
