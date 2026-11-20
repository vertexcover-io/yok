import { join } from "node:path";
import * as z from "zod";
import { NonEmptyStringSchema } from "./contracts.ts";

// GitHub's permanent account id and login, and the token while yok holds access to it.
const GitHubAccountSchema = z.strictObject({
  id: z.number().int(),
  login: NonEmptyStringSchema,
  token: NonEmptyStringSchema.optional(),
});

// One entry per provider account the person has shown yok, so another provider is one more key.
// Which providers can sign someone in is the server's choice, not stored here.
export const UserSchema = z.strictObject({
  name: NonEmptyStringSchema,
  email: z.string(),
  accounts: z.strictObject({ github: GitHubAccountSchema.optional() }),
  // the Slack member id `@yok login` linked; absent until the person links
  slack: NonEmptyStringSchema.optional(),
  // when a GitHub sign-in was refused for this person; absent while they have access
  accessRevokedAt: z.iso.datetime().optional(),
});
export type User = z.infer<typeof UserSchema>;
export type Accounts = User["accounts"];

export const ApiTokenSchema = z.strictObject({
  id: NonEmptyStringSchema,
  userId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export type UserEntry = readonly [id: string, user: User];

const GITHUB_HTTPS = "url.https://github.com/.insteadOf";

// Answers from GH_TOKEN alone, and with nothing when it is empty: `gh auth git-credential` would
// fall back to the server's login in the system keyring, which GH_CONFIG_DIR does not isolate.
const GH_TOKEN_HELPER =
  '!f() { test "$1" = get && test -n "$GH_TOKEN" && printf \'username=x-access-token\\npassword=%s\\n\' "$GH_TOKEN"; }; f';

// Each run's env carries its own git config, so no run writes the shared ~/.gitconfig. An empty
// value resets a credential helper list, dropping helpers set in the machine's config; the
// URL-scoped list is reset too, because `gh auth setup-git` and saved passwords live there.
const ISOLATED_GIT: readonly (readonly [key: string, value: string])[] = [
  ["credential.helper", ""],
  ["credential.https://github.com.helper", ""],
  ["credential.https://github.com.helper", GH_TOKEN_HELPER],
  [GITHUB_HTTPS, "git@github.com:"],
  [GITHUB_HTTPS, "ssh://git@github.com/"],
];

const gitConfigEnv = (entries: typeof ISOLATED_GIT): Record<string, string> =>
  Object.fromEntries([
    ["GIT_CONFIG_COUNT", String(entries.length)],
    ...entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ]);

const authorEnv = ({ id, login }: NonNullable<Accounts["github"]>): Record<string, string> => {
  const email = `${id}+${login}@users.noreply.github.com`;
  return {
    GIT_AUTHOR_NAME: login,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: login,
    GIT_COMMITTER_EMAIL: email,
  };
};

// What an owned run's session sees of GitHub: its owner's token and name, or nothing at all,
// never the server's own gh login. Both token keys are always set, empty without a token,
// because the session's env is laid over the server's own, which may export either.
export const ownerEnv = (
  env: Readonly<Record<string, string>>,
  home: string,
  owner: User | undefined,
): Record<string, string> => {
  const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...rest } = env;
  const github = owner?.accounts.github;
  const token = github?.token;
  return {
    ...rest,
    GH_CONFIG_DIR: join(home, "gh-owned"),
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    // An askpass program (VS Code's bridge in any of its terminals) still answers once no helper
    // does. An empty GIT_ASKPASS means none, and git then skips core.askPass and SSH_ASKPASS too.
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    ...gitConfigEnv(ISOLATED_GIT),
    ...(github === undefined || token === undefined
      ? { GH_TOKEN: "", GITHUB_TOKEN: "" }
      : { GH_TOKEN: token, GITHUB_TOKEN: token, ...authorEnv(github) }),
  };
};
