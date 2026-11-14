import { Hono } from 'hono';
import type { AppEnv } from '../auth';

export const archivos = new Hono<AppEnv>();
