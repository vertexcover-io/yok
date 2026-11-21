import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { GitHubSignIn, ImportedUser, IUserRepository, UserAccount } from "../repositories.ts";
import * as tables from "../schema.ts";
import { type Accounts, type UserEntry, UserSchema } from "../users.ts";
import { type Db, IMMEDIATE, now } from "./common.ts";

type UserRow = typeof tables.users.$inferSelect;
type AccountRow = typeof tables.userAccounts.$inferSelect;

const { users, userAccounts } = tables;
const GITHUB = "github";
const SLACK = "slack";
const newUserId = (): string => `u_${randomBytes(4).toString("hex")}`;

const githubAccount = (account: AccountRow | undefined): Accounts =>
  account === undefined
    ? {}
    : {
        github: {
          id: Number(account.providerId),
          login: account.username ?? "",
          ...(account.token === null ? {} : { token: account.token }),
        },
      };

const toUserEntry = (row: UserRow, accounts: readonly AccountRow[]): UserEntry => {
  const slack = accounts.find((account) => account.provider === SLACK);
  const user = UserSchema.parse({
    name: row.name,
    email: row.email,
    accounts: githubAccount(accounts.find((account) => account.provider === GITHUB)),
    ...(slack === undefined ? {} : { slack: slack.providerId }),
  });
  return [row.id, user];
};

// All users, or those with the given ids, oldest first.
const userEntries = (db: Db, ids?: readonly string[]): readonly UserEntry[] => {
  const all = db.select().from(users);
  const rows = (ids === undefined ? all : all.where(inArray(users.id, [...ids])))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all();
  const owned = inArray(
    userAccounts.userId,
    rows.map((row) => row.id),
  );
  const accounts = db.select().from(userAccounts).where(owned).all();
  return rows.map((row) =>
    toUserEntry(
      row,
      accounts.filter((account) => account.userId === row.id),
    ),
  );
};

const accountOwner = (db: Db, provider: string, providerId: string): string | undefined =>
  db
    .select({ userId: userAccounts.userId })
    .from(userAccounts)
    .where(and(eq(userAccounts.provider, provider), eq(userAccounts.providerId, providerId)))
    .get()?.userId;

// One account belongs to one yok user: saving it for userId moves it off anyone who had it. The
// row is replaced whole, so a token left out is dropped.
const putAccount = (tx: Db, userId: string, account: UserAccount, at: string): void => {
  const { provider, providerId } = account;
  tx.delete(userAccounts)
    .where(
      and(
        eq(userAccounts.provider, provider),
        eq(userAccounts.providerId, providerId),
        ne(userAccounts.userId, userId),
      ),
    )
    .run();
  const fields = {
    providerId,
    username: account.username ?? null,
    token: account.token ?? null,
    updatedAt: at,
  };
  tx.insert(userAccounts)
    .values({ userId, provider, ...fields, createdAt: at })
    .onConflictDoUpdate({ target: [userAccounts.userId, userAccounts.provider], set: fields })
    .run();
};

// The same GitHub account always maps to the same yok user; its name, email and login follow
// GitHub's on every sign-in, and the sign-in's token becomes its GitHub connector. The account is
// looked up under the write lock, so two first sign-ins of one account make one user.
const saveGitHubRows = (db: Db, input: GitHubSignIn): string =>
  db.transaction((tx) => {
    const at = now();
    const providerId = String(input.id);
    const id = accountOwner(tx, GITHUB, providerId) ?? newUserId();
    const person = { name: input.name, email: input.email, updatedAt: at };
    tx.insert(users)
      .values({ id, ...person, createdAt: at })
      .onConflictDoUpdate({ target: users.id, set: person })
      .run();
    const account = { provider: GITHUB, providerId, username: input.login, token: input.token };
    putAccount(tx, id, account, at);
    return id;
  }, IMMEDIATE);

// The rows saveGitHubUser and a Slack link would have written, for a user users.json held.
const importedAccountRows = (
  userId: string,
  { github, slack }: ImportedUser,
  at: string,
): (typeof userAccounts.$inferInsert)[] => {
  const stamps = { userId, createdAt: at, updatedAt: at };
  return [
    ...(github === undefined
      ? []
      : [
          {
            ...stamps,
            provider: GITHUB,
            providerId: String(github.id),
            username: github.login,
            token: github.token ?? null,
          },
        ]),
    ...(slack === undefined ? [] : [{ ...stamps, provider: SLACK, providerId: slack }]),
  ];
};

const importUserIn = (db: Db, id: string, user: ImportedUser, at: string): void =>
  db.transaction((tx) => {
    tx.insert(users)
      .values({ id, name: user.name, email: user.email, createdAt: at, updatedAt: at })
      .onConflictDoNothing()
      .run();
    const accounts = importedAccountRows(id, user, at);
    if (accounts.length > 0) tx.insert(userAccounts).values(accounts).onConflictDoNothing().run();
  }, IMMEDIATE);

export const userRepository = (db: Db): IUserRepository => ({
  list: async () => userEntries(db),
  find: async (id) => userEntries(db, [id])[0]?.[1],
  findByAccount: async (provider, providerId) => {
    const id = accountOwner(db, provider, providerId);
    return id === undefined ? undefined : userEntries(db, [id])[0];
  },
  saveGitHubUser: async (input) => {
    const id = saveGitHubRows(db, input);
    const [entry] = userEntries(db, [id]);
    if (entry === undefined) throw new Error(`user ${id} was not saved`);
    return entry;
  },
  addUserAccount: async (userId, account) => {
    db.transaction((tx) => putAccount(tx, userId, account, now()), IMMEDIATE);
  },
  removeUserAccount: async (userId, provider) => {
    db.delete(userAccounts)
      .where(and(eq(userAccounts.userId, userId), eq(userAccounts.provider, provider)))
      .run();
  },
  importUser: async (id, user) => importUserIn(db, id, user, now()),
});
