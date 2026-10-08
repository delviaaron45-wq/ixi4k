#!/usr/bin/env node
/**
 * ixi 4k — Configuración segura de las credenciales de administrador.
 *
 * Genera el hash bcrypt de la contraseña y lo guarda FUERA del repositorio,
 * en ~/.ixi4k/admin_credentials.json (permisos 600).
 *
 *   npm run admin:setup
 *
 * Alternativa (sin fichero): define en el proceso de la app
 *   IXI4K_ADMIN_EMAIL=...  IXI4K_ADMIN_PASSWORD_HASH=$2b$12$...
 *
 * La contraseña NUNCA se guarda en texto plano ni se escribe en el bundle.
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const COST = 12;

async function ask(rl, question, { silent = false } = {}) {
  if (!silent) return rl.question(question);
  // Lectura oculta de la contraseña
  const stdin = input;
  const onData = (chunk) => {
    const s = chunk.toString('utf8');
    if (s.includes('\n') || s.includes('\r') || s === '\u0003') stdin.pause();
  };
  stdin.on('data', onData);
  const answer = await rl.question(question);
  stdin.removeListener('data', onData);
  process.stdout.write('\n');
  return answer;
}

async function main() {
  const rl = createInterface({ input, output });

  const email = (
    process.env.IXI4K_ADMIN_EMAIL || (await ask(rl, 'Email del administrador: '))
  )
    .trim()
    .toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    rl.close();
    console.error('✖ El email no es válido.');
    process.exitCode = 1;
    return;
  }

  const password =
    process.env.IXI4K_ADMIN_PASSWORD ||
    (await ask(rl, 'Contraseña del administrador: ', { silent: true }));

  if (!password || password.length < 8) {
    rl.close();
    console.error('✖ La contraseña debe tener al menos 8 caracteres.');
    process.exitCode = 1;
    return;
  }

  const hash = bcrypt.hashSync(password, COST);

  const dir = join(homedir(), '.ixi4k');
  const file = join(dir, 'admin_credentials.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    JSON.stringify(
      {
        email,
        password_hash: hash,
        algorithm: 'bcrypt',
        cost: COST,
        created_at: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  rl.close();
  console.log('✔ Credenciales de administrador guardadas (hash bcrypt, cost 12).');
  console.log(`  Fichero : ${file}`);
  console.log(`  Email   : ${email}`);
  console.log('  La contraseña NO se ha escrito en ningún sitio en texto plano.');
  if (existsSync(file)) console.log('  → Ya puedes iniciar sesión desde la app de escritorio.');
}

main().catch((err) => {
  console.error('✖ Error:', err.message);
  process.exitCode = 1;
});
