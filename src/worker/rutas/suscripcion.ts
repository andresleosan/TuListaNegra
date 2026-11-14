import { Hono } from 'hono';
import type { AppEnv } from '../auth';

export const suscripcion = new Hono<AppEnv>();
