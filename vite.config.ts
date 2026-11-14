import { createHash } from 'node:crypto';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { importJWK, SignJWT } from 'jose';
import { defineConfig, type Plugin } from 'vite';
import { identidadLocal } from './scripts/dev-identidad.mjs';

/**
 * Simulador local de identidad: solo en el servidor de desarrollo (`apply: 'serve'`); no existe ni en el Worker
 * ni en el build. `POST /__dev/token` firma un ID token con la forma de los de Firebase usando la llave local de
 * `scripts/dev-identidad.mjs`; el Worker lo verifica como cualquier otro. Sin llave local responde 404.
 */
function simuladorDeIdentidad(): Plugin {
  return {
    name: 'tln-simulador-de-identidad',
    apply: 'serve',
    configureServer(servidor) {
      servidor.middlewares.use('/__dev/token', async (req, res) => {
        const identidad = identidadLocal();
        if (!identidad) return void res.writeHead(404).end();
        if (req.method !== 'POST') return void res.writeHead(204).end(); // sondeo: «¿hay simulador?»
        try {
          let cuerpo = '';
          for await (const trozo of req) cuerpo += trozo;
          const { uid, email, email_verified, proveedor } = JSON.parse(cuerpo);
          if (typeof email !== 'string' || !email.includes('@')) throw new Error('correo');
          const correo = email.trim().toLowerCase();
          const token = await new SignJWT({
            email: correo,
            email_verified: email_verified === true,
            firebase: { sign_in_provider: proveedor === 'password' ? 'password' : 'google.com' },
          })
            .setProtectedHeader({ alg: 'RS256', kid: identidad.kid })
            .setIssuer(`https://securetoken.google.com/${identidad.proyecto}`)
            .setAudience(identidad.proyecto)
            // Sin uid, uno estable derivado del correo: la misma cuenta simulada es siempre la misma.
            .setSubject(typeof uid === 'string' && uid ? uid : `sim_${createHash('sha256').update(correo).digest('hex').slice(0, 20)}`)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(await importJWK(identidad.privada, 'RS256'));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ token }));
        } catch {
          res.writeHead(400).end();
        }
      });
    },
  };
}

// E2E_ESTADO: carpeta propia para D1 y R2 locales, para que varios recorridos de navegador corran a la vez sin pisarse.
const estado = process.env.E2E_ESTADO;

export default defineConfig({ plugins: [simuladorDeIdentidad(), react(), cloudflare(estado ? { persistState: { path: estado } } : {})] });
