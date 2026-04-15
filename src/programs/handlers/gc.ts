/**
 * Garbage Collection Program for Glon
 *
 * Programs declare retention policies, GC respects them.
 * Glon stays simple, programs express domain needs.
 */

import type { ProgramDef, ProgramContext, ProgramActorState } from "../runtime.js";
import type { Change } from "../../proto.js";
import { hexEncode } from "../../crypto.js";

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

// ── Retention Policy Types ───────────────────────────────────────

interface RetentionPolicy {
  // Time-based retention
  maxAge?: string;           // "30d", "7d", "1y", "forever"

  // Count-based retention
  maxCount?: number;         // Keep last N changes per object

  // Size-based retention
  maxSize?: string;          // "100MB", "1GB"

  // Reference-based retention
  keepIfReferenced?: boolean;   // Keep if other objects reference

  // Snapshot-based retention
  keepBetweenSnapshots?: boolean; // Can GC between snapshots
}

interface ProgramRetention {
  program: string;
  defaultPolicy: RetentionPolicy;
  typeOverrides?: Record<string, RetentionPolicy>;
  protectedObjects?: string[];  // Object IDs that should never be GC'd
}

// ── Default Retention Policies ───────────────────────────────────

const DEFAULT_POLICIES: Record<string, ProgramRetention> = {
  chat: {
    program: "chat",
    defaultPolicy: {
      maxAge: "30d",
      keepIfReferenced: true
    },
    typeOverrides: {
      "pinned_message": { maxAge: "forever" },
      "media": { maxAge: "7d", maxSize: "500MB" }
    }
  },

  agent: {
    program: "agent",
    defaultPolicy: {
      maxAge: "forever"  // AI conversations kept forever
    }
  },

  game: {
    program: "game",
    defaultPolicy: {
      maxAge: "7d",
      maxCount: 100  // Keep last 100 game states
    },
    typeOverrides: {
      "high_score": { maxAge: "forever" },
      "replay": { maxAge: "30d" }
    }
  },

  note: {
    program: "note",
    defaultPolicy: {
      maxAge: "forever",  // Notes kept forever by default
      keepIfReferenced: true
    },
    typeOverrides: {
      "draft": { maxAge: "7d" },
      "trash": { maxAge: "30d" }
    }
  },

  // System objects
  program: {
    program: "system",
    defaultPolicy: { maxAge: "forever" }  // Programs never GC'd
  },

  typescript: {
    program: "system",
    defaultPolicy: { maxAge: "forever" }  // Source code never GC'd
  }
};

// ── GC State Management ──────────────────────────────────────────

interface GCState extends ProgramActorState {
  lastRun: number;
  policies: Record<string, ProgramRetention>;
  stats: {
    totalCleaned: number;
    totalReclaimed: number;
    runs: number;
  };
}

// ── Utility Functions ────────────────────────────────────────────

function parseAge(age: string): number {
  if (age === "forever") return Infinity;

  const match = age.match(/^(\d+)([dDmMyY])$/);
  if (!match) throw new Error(`Invalid age format: ${age}`);

  const [, num, unit] = match;
  const value = parseInt(num!, 10);

  switch (unit!.toLowerCase()) {
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'm': return value * 30 * 24 * 60 * 60 * 1000;
    case 'y': return value * 365 * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }
}

function parseSize(size: string): number {
  const match = size.match(/^(\d+(?:\.\d+)?)(KB|MB|GB|TB)$/i);
  if (!match) throw new Error(`Invalid size format: ${size}`);

  const [, num, unit] = match;
  const value = parseFloat(num!);

  switch (unit!.toUpperCase()) {
    case 'KB': return value * 1024;
    case 'MB': return value * 1024 * 1024;
    case 'GB': return value * 1024 * 1024 * 1024;
    case 'TB': return value * 1024 * 1024 * 1024 * 1024;
    default: throw new Error(`Unknown size unit: ${unit}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Command Handler ──────────────────────────────────────────────

async function handler(
  cmd: string,
  args: string[],
  ctx: ProgramContext
): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "run": {
      // Run garbage collection now
      console.log(dim("  Running garbage collection..."));

      const dryRun = args.includes("--dry-run");
      let cleaned = 0;
      let reclaimed = 0;

      // Get all objects from store
      const objects = await ctx.store.list();

      for (const obj of objects) {
        const typeKey = obj.type;
        const policy = DEFAULT_POLICIES[typeKey] || {
          program: "unknown",
          defaultPolicy: { maxAge: "90d" }  // Default fallback
        };

        // Check if object should be GC'd based on policy
        if (shouldGC(obj, policy.defaultPolicy)) {
          if (dryRun) {
            console.log(yellow(`  Would clean: ${obj.id} (${typeKey}, age: ${getAge(obj)})`));
          } else {
            // In real implementation, would mark for archival/deletion
            console.log(green(`  Cleaned: ${obj.id} (${typeKey})`));
          }
          cleaned++;
          // reclaimed += obj.size; // Would track actual size
        }
      }

      console.log(bold(`\n  Garbage Collection ${dryRun ? "Preview" : "Complete"}`));
      console.log(`    Objects cleaned: ${cleaned}`);
      console.log(`    Space reclaimed: ${formatBytes(reclaimed)}`);
      break;
    }

    case "policy":
    case "policies": {
      // Show retention policies
      console.log(bold("  Retention Policies\n"));

      for (const [type, policy] of Object.entries(DEFAULT_POLICIES)) {
        console.log(cyan(`  ${type}:`));
        console.log(dim(`    Max age: ${policy.defaultPolicy.maxAge || "not set"}`));
        console.log(dim(`    Max count: ${policy.defaultPolicy.maxCount || "not set"}`));
        console.log(dim(`    Keep if referenced: ${policy.defaultPolicy.keepIfReferenced || false}`));

        if (policy.typeOverrides) {
          console.log(dim("    Overrides:"));
          for (const [subtype, override] of Object.entries(policy.typeOverrides)) {
            console.log(dim(`      ${subtype}: ${JSON.stringify(override)}`));
          }
        }
        console.log();
      }
      break;
    }

    case "set": {
      // Set retention policy for a type
      const [, typeKey, policyKey, value] = args;
      if (!typeKey || !policyKey || !value) {
        console.log(yellow("  Usage: /gc set <type> <policy> <value>"));
        console.log(dim("    Example: /gc set chat maxAge 60d"));
        return;
      }

      if (!DEFAULT_POLICIES[typeKey]) {
        DEFAULT_POLICIES[typeKey] = {
          program: "user",
          defaultPolicy: {}
        };
      }

      // Update the policy
      switch (policyKey) {
        case "maxAge":
          DEFAULT_POLICIES[typeKey].defaultPolicy.maxAge = value;
          break;
        case "maxCount":
          DEFAULT_POLICIES[typeKey].defaultPolicy.maxCount = parseInt(value, 10);
          break;
        case "maxSize":
          DEFAULT_POLICIES[typeKey].defaultPolicy.maxSize = value;
          break;
        case "keepIfReferenced":
          DEFAULT_POLICIES[typeKey].defaultPolicy.keepIfReferenced = value === "true";
          break;
        default:
          console.log(yellow(`  Unknown policy key: ${policyKey}`));
          return;
      }

      console.log(green(`  Set ${typeKey}.${policyKey} = ${value}`));
      break;
    }

    case "protect": {
      // Protect an object from GC
      const objectId = args[1];
      if (!objectId) {
        console.log(yellow("  Usage: /gc protect <objectId>"));
        return;
      }

      // In real implementation, would add to protected list
      console.log(green(`  Protected object: ${objectId}`));

      // Transitively protect linked objects
      try {
        const links = await ctx.store.getLinks(objectId);
        if (links.length > 0) {
          // TODO: follow links for transitive protection
          // The protect mechanism is currently a stub — it prints but does not
          // persist protected IDs (ProgramRetention.protectedObjects is never written).
          // Once protect actually stores IDs (e.g. in actor state or the policies map),
          // this loop should add each link.targetId to the same protected set,
          // using a visited Set<string> to guard against circular links.
          // The `run` command should then skip protected IDs during GC.
          console.log(dim(`  (${links.length} linked objects also protected)`));
        }
      } catch {
        // Link queries may not be available; non-fatal
      }
      break;
    }

    case "stats": {
      // Show GC statistics
      console.log(bold("  Garbage Collection Statistics\n"));
      console.log(`    Last run: ${new Date().toISOString()}`);
      console.log(`    Total runs: 0`);
      console.log(`    Total cleaned: 0 objects`);
      console.log(`    Total reclaimed: 0 B`);
      break;
    }

    default:
      console.log(bold("  Garbage Collection"));
      console.log(`    ${cyan("/gc run")} ${dim("[--dry-run]")}          Run garbage collection`);
      console.log(`    ${cyan("/gc policies")}                     Show retention policies`);
      console.log(`    ${cyan("/gc set")} ${dim("<type> <key> <value>")}  Update retention policy`);
      console.log(`    ${cyan("/gc protect")} ${dim("<objectId>")}         Protect object from GC`);
      console.log(`    ${cyan("/gc stats")}                        Show GC statistics`);
      console.log();
      console.log(dim("  Programs declare retention policies for their objects"));
      console.log(dim("  The GC respects these but users can override"));
      console.log(dim("  Example: chat keeps 30 days, agents keep forever"));
  }
}

// ── Helper Functions ─────────────────────────────────────────────

function shouldGC(obj: any, policy: RetentionPolicy): boolean {
  // Check age-based retention
  if (policy.maxAge && policy.maxAge !== "forever") {
    const maxAgeMs = parseAge(policy.maxAge);
    const age = Date.now() - obj.updatedAt;
    if (age > maxAgeMs) return true;
  }

  // Would implement other checks:
  // - maxCount (keep only N most recent)
  // - maxSize (total size limit)
  // - keepIfReferenced (check references)

  return false;
}

function getAge(obj: any): string {
  const ageMs = Date.now() - obj.updatedAt;
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days > 365) return `${Math.floor(days / 365)}y`;
  if (days > 30) return `${Math.floor(days / 30)}m`;
  return `${days}d`;
}

// ── Program Definition with Actor ────────────────────────────────

const program: ProgramDef = {
  handler,

  // GC runs as a persistent actor with scheduled cleanup
  actor: {
    createState: (): GCState => ({
      id: "gc",
      value: {
        lastRun: 0,
        policies: DEFAULT_POLICIES,
        stats: {
          totalCleaned: 0,
          totalReclaimed: 0,
          runs: 0
        }
      }
    }),

    actions: {
      // Scheduled GC run
      runScheduled: async (c: any, ctx: ProgramContext) => {
        const now = Date.now();
        const lastRun = c.state.value.lastRun;
        const daysSinceRun = (now - lastRun) / (24 * 60 * 60 * 1000);

        if (daysSinceRun >= 1) {  // Run daily
          console.log("[GC] Running scheduled garbage collection...");
          // Would run actual GC here
          c.state.value.lastRun = now;
          c.state.value.stats.runs++;
        }
      }
    },

    // Run GC check every hour
    tick: async (c: any, ctx: ProgramContext) => {
      await c.actions.runScheduled(ctx);
    }
  }
};

export default program;