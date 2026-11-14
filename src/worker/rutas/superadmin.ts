import { Hono } from 'hono';
import type { AppEnv } from '../auth';

export const superadmin = new Hono<AppEnv>();
