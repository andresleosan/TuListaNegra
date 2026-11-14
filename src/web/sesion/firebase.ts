// Sesión de producción: Firebase Auth (Google y correo/contraseña). Se carga con `import()` para que
// el SDK no pese en el arranque. Firebase guarda su sesión en IndexedDB; la app no guarda tokens.
import { FirebaseError, initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { ErrorDeIngreso, type ProveedorSesion, type Usuario } from './index';

const MENSAJES: Record<string, string> = {
  'auth/invalid-credential': 'El correo o la contraseña no coinciden. Revísalos e intenta de nuevo.',
  'auth/invalid-email': 'Ese correo no parece completo. Revisa que tenga @ y dominio, como nombre@correo.com.',
  'auth/email-already-in-use': 'Ya hay una cuenta con ese correo. Entra con ella en vez de crear otra.',
  'auth/weak-password': 'La contraseña es muy corta: usa al menos 6 caracteres.',
  'auth/too-many-requests': 'Demasiados intentos seguidos. Espera unos minutos y vuelve a probar.',
  'auth/network-request-failed': 'No hay conexión. Revisa tu internet e intenta de nuevo.',
  'auth/popup-blocked': 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes e intenta de nuevo.',
};
// Cerrar la ventana de Google no es un error que haya que explicar.
const SILENCIOSOS = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request']);

async function intentar(accion: () => Promise<unknown>) {
  try {
    await accion();
  } catch (e) {
    const codigo = e instanceof FirebaseError ? e.code : '';
    if (SILENCIOSOS.has(codigo)) return;
    throw new ErrorDeIngreso(MENSAJES[codigo] ?? 'No pudimos entrar. Intenta de nuevo en un momento.');
  }
}

export async function crearFirebase(config: FirebaseOptions): Promise<ProveedorSesion> {
  const auth = getAuth(initializeApp(config));
  auth.languageCode = 'es';
  await auth.authStateReady(); // desde aquí `currentUser` ya dice si había sesión guardada

  let actual: Usuario | null = null;
  const leer = () => {
    const u = auth.currentUser;
    if (u?.uid !== actual?.uid || (u?.email ?? null) !== (actual?.email ?? null)) actual = u && { uid: u.uid, email: u.email };
    return actual;
  };

  return {
    usuario: leer,
    suscribir: (alCambiar) => onAuthStateChanged(auth, alCambiar),
    async token() {
      const u = auth.currentUser;
      if (!u) throw new ErrorDeIngreso('Sin sesión');
      // Un correo recién verificado no aparece en el token guardado: se consulta y, si cambió, se renueva.
      if (!u.emailVerified) {
        await u.reload();
        if (u.emailVerified) return u.getIdToken(true);
      }
      return u.getIdToken();
    },
    entrarConGoogle: () => intentar(() => signInWithPopup(auth, new GoogleAuthProvider())),
    entrarConCorreo: (correo, clave) => intentar(() => signInWithEmailAndPassword(auth, correo, clave)),
    registrarConCorreo: (correo, clave) =>
      intentar(async () => {
        const { user } = await createUserWithEmailAndPassword(auth, correo, clave);
        await sendEmailVerification(user);
      }),
    salir: () => signOut(auth),
  };
}
