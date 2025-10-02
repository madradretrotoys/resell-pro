import { api } from '/assets/js/api.js';
export async function ensureSession(){ try{ return await api('/api/auth/session'); } catch{ return { user:null, memberships:[] }; } }
