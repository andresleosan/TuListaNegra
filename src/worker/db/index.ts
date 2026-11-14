import { drizzle } from 'drizzle-orm/d1';

export const bd = (env: Env) => drizzle(env.DB);
