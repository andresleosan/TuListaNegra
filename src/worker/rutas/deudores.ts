import { Hono } from 'hono';
import type { AppEnv } from '../auth';

export const deudores = new Hono<AppEnv>();
