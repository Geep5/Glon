/**
 * Accounts & Permissions System for Glon OS
 *
 * Manages user accounts, authentication, and object permissions.
 * Programs run with user permissions and can only modify their own objects.
 */

import type { ProgramDef, ProgramContext, ProgramActorState } from "../runtime.js";
import { hexEncode, sha256 } from "../../crypto.js";

// ── ANSI ─────────────────────────────────────────────────────────
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }

// ── Account Types ────────────────────────────────────────────────

interface Account {
  id: string;
  username: string;
  passwordHash: string;
  role: "admin" | "user" | "guest";
  created: number;
  lastLogin?: number;
  permissions: Permission[];
}

interface Permission {
  resource: string;        // Object ID, type, or wildcard
  actions: Action[];       // What can be done
  granted_by?: string;     // Who granted this permission
  expires?: number;        // Optional expiration
}

type Action = "read" | "write" | "delete" | "execute" | "grant";

interface Session {
  accountId: string;
  token: string;
  created: number;
  expires: number;
  ip?: string;
}

interface ObjectOwnership {
  objectId: string;
  ownerId: string;
  created: number;
  permissions: {
    owner: Action[];
    group?: Action[];
    others?: Action[];
  };
}

// ── Accounts State ───────────────────────────────────────────────

interface AccountsState extends ProgramActorState {
  accounts: Record<string, Account>;
  sessions: Record<string, Session>;
  ownership: Record<string, ObjectOwnership>;
  currentUser?: string;  // Current session user
}

// ── Default Accounts ─────────────────────────────────────────────

const DEFAULT_ACCOUNTS: Record<string, Account> = {
  admin: {
    id: "admin",
    username: "admin",
    passwordHash: sha256(new TextEncoder().encode("admin")).toString('hex'),
    role: "admin",
    created: Date.now(),
    permissions: [
      {
        resource: "*",  // All resources
        actions: ["read", "write", "delete", "execute", "grant"]
      }
    ]
  },
  guest: {
    id: "guest",
    username: "guest",
    passwordHash: "",  // No password for guest
    role: "guest",
    created: Date.now(),
    permissions: [
      {
        resource: "*",
        actions: ["read"]  // Read-only by default
      }
    ]
  }
};

// ── Permission Checking ──────────────────────────────────────────

function hasPermission(
  account: Account,
  resource: string,
  action: Action
): boolean {
  // Admins have all permissions
  if (account.role === "admin") return true;

  // Check specific permissions
  for (const perm of account.permissions) {
    // Check if permission expired
    if (perm.expires && perm.expires < Date.now()) continue;

    // Check resource match (supports wildcards)
    if (perm.resource === "*" ||
        perm.resource === resource ||
        (perm.resource.endsWith("*") &&
         resource.startsWith(perm.resource.slice(0, -1)))) {

      if (perm.actions.includes(action)) {
        return true;
      }
    }
  }

  return false;
}

function checkOwnership(
  ownership: ObjectOwnership,
  accountId: string,
  action: Action
): boolean {
  // Owner has full permissions
  if (ownership.ownerId === accountId) {
    return ownership.permissions.owner.includes(action);
  }

  // Check other permissions
  if (ownership.permissions.others) {
    return ownership.permissions.others.includes(action);
  }

  return false;
}

// ── Command Handler ──────────────────────────────────────────────

async function handler(
  cmd: string,
  args: string[],
  ctx: ProgramContext
): Promise<void> {
  const subcommand = args[0];

  // Get current state (would be from actor in real impl)
  const state: AccountsState = {
    id: "accounts",
    value: {
      accounts: DEFAULT_ACCOUNTS,
      sessions: {},
      ownership: {},
      currentUser: "admin"  // Default to admin for now
    }
  };

  switch (subcommand) {
    case "whoami": {
      const currentUser = state.currentUser || "guest";
      const account = state.accounts[currentUser];

      console.log(bold(`  Current User`));
      console.log(`    Username: ${cyan(account.username)}`);
      console.log(`    Role: ${account.role === "admin" ? green(account.role) : yellow(account.role)}`);
      console.log(`    ID: ${dim(account.id)}`);

      if (account.permissions.length > 0) {
        console.log(`    Permissions:`);
        for (const perm of account.permissions) {
          console.log(`      ${dim(perm.resource)}: ${perm.actions.join(", ")}`);
        }
      }
      break;
    }

    case "create": {
      const username = args[1];
      const password = args[2];
      const role = (args[3] as "admin" | "user" | "guest") || "user";

      if (!username || !password) {
        console.log(yellow("  Usage: /accounts create <username> <password> [role]"));
        return;
      }

      // Check if current user can create accounts
      const currentAccount = state.accounts[state.currentUser || "guest"];
      if (!hasPermission(currentAccount, "accounts", "write")) {
        console.log(red("  Permission denied: Cannot create accounts"));
        return;
      }

      // Check if username exists
      if (Object.values(state.accounts).find(a => a.username === username)) {
        console.log(red(`  Account '${username}' already exists`));
        return;
      }

      const newAccount: Account = {
        id: `user_${Date.now()}`,
        username,
        passwordHash: sha256(new TextEncoder().encode(password)).toString('hex'),
        role,
        created: Date.now(),
        permissions: role === "user" ? [
          {
            resource: `user:${username}/*`,  // Own objects
            actions: ["read", "write", "delete"]
          }
        ] : []
      };

      state.accounts[newAccount.id] = newAccount;
      console.log(green(`  Created account: ${username} (${role})`));
      break;
    }

    case "login": {
      const username = args[1];
      const password = args[2];

      if (!username) {
        console.log(yellow("  Usage: /accounts login <username> [password]"));
        return;
      }

      const account = Object.values(state.accounts).find(a => a.username === username);
      if (!account) {
        console.log(red(`  Account '${username}' not found`));
        return;
      }

      // Check password (skip for guest)
      if (account.role !== "guest" && password) {
        const hash = sha256(new TextEncoder().encode(password)).toString('hex');
        if (hash !== account.passwordHash) {
          console.log(red("  Invalid password"));
          return;
        }
      }

      // Create session
      const token = hexEncode(crypto.getRandomValues(new Uint8Array(32)));
      state.sessions[token] = {
        accountId: account.id,
        token,
        created: Date.now(),
        expires: Date.now() + 24 * 60 * 60 * 1000  // 24 hours
      };

      state.currentUser = account.id;
      account.lastLogin = Date.now();

      console.log(green(`  Logged in as ${username}`));
      console.log(dim(`  Session: ${token.slice(0, 16)}...`));
      break;
    }

    case "logout": {
      state.currentUser = "guest";
      console.log(green("  Logged out"));
      break;
    }

    case "grant": {
      const username = args[1];
      const resource = args[2];
      const actions = args[3]?.split(",") as Action[];

      if (!username || !resource || !actions) {
        console.log(yellow("  Usage: /accounts grant <username> <resource> <actions>"));
        console.log(dim("    Example: /accounts grant alice chat:* read,write"));
        return;
      }

      // Check if current user can grant permissions
      const currentAccount = state.accounts[state.currentUser || "guest"];
      if (!hasPermission(currentAccount, resource, "grant")) {
        console.log(red("  Permission denied: Cannot grant permissions for this resource"));
        return;
      }

      const targetAccount = Object.values(state.accounts).find(a => a.username === username);
      if (!targetAccount) {
        console.log(red(`  Account '${username}' not found`));
        return;
      }

      targetAccount.permissions.push({
        resource,
        actions,
        granted_by: currentAccount.id
      });

      console.log(green(`  Granted ${actions.join(", ")} on ${resource} to ${username}`));
      break;
    }

    case "revoke": {
      const username = args[1];
      const resource = args[2];

      if (!username || !resource) {
        console.log(yellow("  Usage: /accounts revoke <username> <resource>"));
        return;
      }

      // Check if current user can revoke permissions
      const currentAccount = state.accounts[state.currentUser || "guest"];
      if (!hasPermission(currentAccount, resource, "grant")) {
        console.log(red("  Permission denied: Cannot revoke permissions for this resource"));
        return;
      }

      const targetAccount = Object.values(state.accounts).find(a => a.username === username);
      if (!targetAccount) {
        console.log(red(`  Account '${username}' not found`));
        return;
      }

      const before = targetAccount.permissions.length;
      targetAccount.permissions = targetAccount.permissions.filter(
        p => p.resource !== resource
      );
      const removed = before - targetAccount.permissions.length;

      console.log(green(`  Revoked ${removed} permission(s) from ${username}`));
      break;
    }

    case "list": {
      console.log(bold("  Accounts\n"));

      for (const account of Object.values(state.accounts)) {
        const roleColor = account.role === "admin" ? green :
                         account.role === "user" ? cyan : yellow;
        console.log(`  ${account.username.padEnd(15)} ${roleColor(account.role.padEnd(10))} ${dim(account.id)}`);

        if (account.lastLogin) {
          const ago = Date.now() - account.lastLogin;
          const mins = Math.floor(ago / 60000);
          console.log(dim(`    Last login: ${mins < 60 ? `${mins}m ago` : `${Math.floor(mins/60)}h ago`}`));
        }
      }
      break;
    }

    case "check": {
      const resource = args[1];
      const action = args[2] as Action;

      if (!resource || !action) {
        console.log(yellow("  Usage: /accounts check <resource> <action>"));
        console.log(dim("    Example: /accounts check chat:123 write"));
        return;
      }

      const currentAccount = state.accounts[state.currentUser || "guest"];
      const allowed = hasPermission(currentAccount, resource, action);

      if (allowed) {
        console.log(green(`  ✓ ${currentAccount.username} can ${action} ${resource}`));
      } else {
        console.log(red(`  ✗ ${currentAccount.username} cannot ${action} ${resource}`));
      }
      break;
    }

    default:
      console.log(bold("  Accounts & Permissions"));
      console.log(`    ${cyan("/accounts whoami")}                 Show current user`);
      console.log(`    ${cyan("/accounts login")} ${dim("<user> [pass]")}    Login as user`);
      console.log(`    ${cyan("/accounts logout")}                 Logout`);
      console.log(`    ${cyan("/accounts create")} ${dim("<user> <pass>")}   Create account`);
      console.log(`    ${cyan("/accounts list")}                   List all accounts`);
      console.log(`    ${cyan("/accounts grant")} ${dim("<user> <res> <act>")} Grant permission`);
      console.log(`    ${cyan("/accounts revoke")} ${dim("<user> <res>")}    Revoke permission`);
      console.log(`    ${cyan("/accounts check")} ${dim("<res> <action>")}   Check permission`);
      console.log();
      console.log(dim("  Permissions are hierarchical: admin > user > guest"));
      console.log(dim("  Resources support wildcards: chat:* matches all chat objects"));
      console.log(dim("  Actions: read, write, delete, execute, grant"));
  }
}

// ── Program Definition with Actor ────────────────────────────────

const program: ProgramDef = {
  handler,

  // Accounts run as a persistent actor managing auth state
  actor: {
    createState: (): AccountsState => ({
      id: "accounts",
      value: {
        accounts: DEFAULT_ACCOUNTS,
        sessions: {},
        ownership: {},
        currentUser: "admin"
      }
    }),

    actions: {
      // Verify a session token
      verifySession: async (c: any, token: string) => {
        const session = c.state.value.sessions[token];
        if (!session) return null;

        if (session.expires < Date.now()) {
          delete c.state.value.sessions[token];
          return null;
        }

        return c.state.value.accounts[session.accountId];
      },

      // Record object ownership
      recordOwnership: async (c: any, objectId: string, ownerId: string) => {
        c.state.value.ownership[objectId] = {
          objectId,
          ownerId,
          created: Date.now(),
          permissions: {
            owner: ["read", "write", "delete"],
            others: ["read"]
          }
        };
      },

      // Check if action is allowed
      checkPermission: async (c: any, accountId: string, objectId: string, action: Action) => {
        const account = c.state.value.accounts[accountId];
        if (!account) return false;

        const ownership = c.state.value.ownership[objectId];
        if (ownership) {
          return checkOwnership(ownership, accountId, action);
        }

        return hasPermission(account, objectId, action);
      }
    }
  }
};

export default program;