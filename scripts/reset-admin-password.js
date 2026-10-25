import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { hashPassword } from 'better-auth/crypto';

/**
 * @typedef {import('better-sqlite3').Database} BetterSqliteDatabase
 */

/**
 * @typedef {{
 * 	id: string;
 * 	email: string;
 * 	username: string | null;
 * 	displayUsername: string | null;
 * 	name: string | null;
 * 	role: string;
 * }} AdminUser
 */

/**
 * @typedef {{
 * 	username: string | null;
 * 	email: string | null;
 * 	userId: string | null;
 * 	password: string | null;
 * 	passwordStdin: boolean;
 * 	listAdmins: boolean;
 * 	keepSessions: boolean;
 * 	help: boolean;
 * }} ParsedArgs
 */

/**
 * @typedef {{
 * 	revokeSessions?: boolean;
 * }} ResetAdminPasswordOptions
 */

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const CREDENTIAL_PROVIDER_ID = 'credential';

/**
 * @returns {string}
 */
export function resolveDbPath() {
	if (process.env.CINEPHAGE_DB_PATH) {
		return process.env.CINEPHAGE_DB_PATH;
	}
	if (process.env.AUTH_DATABASE_URL) {
		return process.env.AUTH_DATABASE_URL;
	}
	if (process.env.DATABASE_URL) {
		return process.env.DATABASE_URL;
	}
	if (process.env.DATA_DIR) {
		return join(process.env.DATA_DIR, 'cinephage.db');
	}
	if (existsSync('/config/data')) {
		return '/config/data/cinephage.db';
	}
	return 'data/cinephage.db';
}

/**
 * @param {string} dbPath
 * @returns {boolean}
 */
function isFilePath(dbPath) {
	return dbPath !== ':memory:' && !dbPath.startsWith('file:');
}

/**
 * @param {string} dbPath
 * @returns {void}
 */
export function assertDbPath(dbPath) {
	if (!isFilePath(dbPath)) {
		return;
	}

	const dir = dirname(dbPath);
	if (!existsSync(dir)) {
		throw new Error(
			`Database directory does not exist: ${dir}. Set CINEPHAGE_DB_PATH, AUTH_DATABASE_URL, DATABASE_URL, or DATA_DIR.`
		);
	}

	if (!existsSync(dbPath)) {
		throw new Error(`Database not found at ${dbPath}.`);
	}
}

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
	/** @type {ParsedArgs} */
	const options = {
		username: null,
		email: null,
		userId: null,
		password: null,
		passwordStdin: false,
		listAdmins: false,
		keepSessions: false,
		help: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];

		if (arg === '--username' && next) {
			options.username = next;
			i++;
			continue;
		}
		if (arg === '--email' && next) {
			options.email = next;
			i++;
			continue;
		}
		if (arg === '--user-id' && next) {
			options.userId = next;
			i++;
			continue;
		}
		if (arg === '--password' && next) {
			options.password = next;
			i++;
			continue;
		}
		if (arg === '--password-stdin') {
			options.passwordStdin = true;
			continue;
		}
		if (arg === '--list-admins') {
			options.listAdmins = true;
			continue;
		}
		if (arg === '--keep-sessions') {
			options.keepSessions = true;
			continue;
		}
		if (arg === '--help' || arg === '-h') {
			options.help = true;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	const selectors = [options.username, options.email, options.userId].filter(Boolean);
	if (selectors.length > 1) {
		throw new Error('Use only one selector: --username, --email, or --user-id.');
	}

	if (options.password && options.passwordStdin) {
		throw new Error('Use only one password input mode: --password or --password-stdin.');
	}

	return options;
}

/**
 * @param {AdminUser} user
 * @returns {string}
 */
function formatAdminUser(user) {
	const identity = user.username || user.email || user.id;
	return `${identity} (id=${user.id})`;
}

/**
 * @param {BetterSqliteDatabase} db
 * @returns {AdminUser[]}
 */
export function listAdminUsers(db) {
	return /** @type {AdminUser[]} */ (
		db
			.prepare(
				`SELECT id, email, username, displayUsername, name, role
				 FROM "user"
				 WHERE role = 'admin'
				 ORDER BY createdAt ASC`
			)
			.all()
	);
}

/**
 * @param {BetterSqliteDatabase} db
 * @param {ParsedArgs} options
 * @returns {AdminUser}
 */
export function selectAdminUser(db, options) {
	const admins = listAdminUsers(db);

	if (admins.length === 0) {
		throw new Error('No admin users found.');
	}

	/** @type {AdminUser[]} */
	let matches;
	if (options.userId) {
		matches = admins.filter((user) => user.id === options.userId);
	} else if (options.email) {
		const email = options.email.toLowerCase();
		matches = admins.filter((user) => user.email?.toLowerCase() === email);
	} else if (options.username) {
		const username = options.username.toLowerCase();
		matches = admins.filter((user) => user.username?.toLowerCase() === username);
	} else if (admins.length === 1) {
		return admins[0];
	} else {
		const adminList = admins.map((user) => `- ${formatAdminUser(user)}`).join('\n');
		throw new Error(
			`Multiple admin users found. Re-run with --username, --email, or --user-id.\n${adminList}`
		);
	}

	if (matches.length === 0) {
		throw new Error('No matching admin user found.');
	}

	if (matches.length > 1) {
		const adminList = matches.map((user) => `- ${formatAdminUser(user)}`).join('\n');
		throw new Error(`Selector matched multiple admin users.\n${adminList}`);
	}

	return matches[0];
}

/**
 * @returns {Promise<string>}
 */
async function readPasswordFromStdin() {
	const input = readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
	return input;
}

/**
 * @param {ParsedArgs} options
 * @returns {Promise<string>}
 */
export async function resolveNewPassword(options) {
	const password = options.passwordStdin ? await readPasswordFromStdin() : options.password;

	if (!password) {
		throw new Error('A new password is required. Use --password or --password-stdin.');
	}

	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
	}

	if (password.length > MAX_PASSWORD_LENGTH) {
		throw new Error(`Password must be no more than ${MAX_PASSWORD_LENGTH} characters.`);
	}

	return password;
}

/**
 * @param {BetterSqliteDatabase} db
 * @param {AdminUser} user
 * @param {string} newPassword
 * @param {ResetAdminPasswordOptions} [options]
 * @returns {Promise<{
 * 	user: AdminUser;
 * 	createdCredentialAccount: boolean;
 * 	revokedSessions: number;
 * }>}
 */
export async function resetAdminPassword(
	db,
	user,
	newPassword,
	options = { revokeSessions: true }
) {
	const hashedPassword = await hashPassword(newPassword);
	const now = new Date().toISOString();

	const existingCredentialAccount = /** @type {{ id: string } | undefined} */ (
		db
			.prepare(
				`SELECT id
				 FROM "account"
				 WHERE userId = ? AND providerId = ?
				 LIMIT 1`
			)
			.get(user.id, CREDENTIAL_PROVIDER_ID)
	);

	if (existingCredentialAccount) {
		db.prepare(
			`UPDATE "account"
			 SET password = ?, updatedAt = ?
			 WHERE id = ?`
		).run(hashedPassword, now, existingCredentialAccount.id);
	} else {
		db.prepare(
			`INSERT INTO "account" (
				id, userId, accountId, providerId, password, createdAt, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(
			randomBytes(16).toString('hex'),
			user.id,
			user.id,
			CREDENTIAL_PROVIDER_ID,
			hashedPassword,
			now,
			now
		);
	}

	let revokedSessions = 0;
	if (options.revokeSessions) {
		const result = db.prepare(`DELETE FROM "session" WHERE userId = ?`).run(user.id);
		revokedSessions = result.changes;
	}

	return {
		user,
		createdCredentialAccount: !existingCredentialAccount,
		revokedSessions
	};
}

/**
 * @returns {void}
 */
function printUsage() {
	console.log(`Reset an admin user's password.

Usage:
  node scripts/reset-admin-password.js [selector] (--password <value> | --password-stdin)
  node scripts/reset-admin-password.js --list-admins

Selectors:
  --username <username>   Target a specific admin username
  --email <email>         Target a specific admin email
  --user-id <id>          Target a specific admin user id

Options:
  --password <value>      New password (convenient but visible in shell history)
  --password-stdin        Read the new password from stdin
  --keep-sessions         Do not revoke existing sessions for the target user
  --list-admins           Print admin accounts and exit
  --help, -h              Show this help

Examples:
  printf '%s' 'NewPass123!' | node scripts/reset-admin-password.js --password-stdin
  printf '%s' 'NewPass123!' | node scripts/reset-admin-password.js --username admin --password-stdin
`);
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<void>}
 */
export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);

	if (options.help) {
		printUsage();
		return;
	}

	const dbPath = resolveDbPath();
	assertDbPath(dbPath);
	const db = new Database(dbPath);
	// Match the shared app connection's pragmas (src/lib/server/db/connection.ts)
	// so the script cooperates with a possibly-running instance.
	db.pragma('journal_mode = WAL');
	db.pragma('busy_timeout = 5000');
	db.pragma('foreign_keys = ON');

	try {
		if (options.listAdmins) {
			const admins = listAdminUsers(db);
			if (admins.length === 0) {
				console.log('No admin users found.');
				return;
			}

			console.log('Admin users:');
			for (const admin of admins) {
				console.log(`- ${formatAdminUser(admin)}`);
			}
			return;
		}

		const newPassword = await resolveNewPassword(options);
		const user = selectAdminUser(db, options);
		const result = await resetAdminPassword(db, user, newPassword, {
			revokeSessions: !options.keepSessions
		});

		console.log(`Password reset for admin user: ${formatAdminUser(result.user)}`);
		if (result.createdCredentialAccount) {
			console.log('Created a new credential account for this admin user.');
		}
		if (!options.keepSessions) {
			console.log(`Revoked ${result.revokedSessions} existing session(s).`);
		}
	} finally {
		db.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error('[reset-admin-password] Failed:', error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
