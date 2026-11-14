// Consola del superadministrador: /api/superadmin/*
import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { requiereSuperadmin } from '../superadmin';

export const superadmin = new Hono<AppEnv>();

// Va primero y cubre todo lo que se registre en este archivo, exista o no la ruta.
superadmin.use('*', requiereSuperadmin);

superadmin.get('/yo', (c) => c.json({ email: c.var.sesion.email }));
