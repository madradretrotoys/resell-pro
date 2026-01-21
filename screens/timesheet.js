
// /timesheet.js
import { api } from '/assets/js/api.js';
import { showToast } from '/assets/js/ui.js';

let els = {};
let sessionUser = null;

export async function init({ container, session }) {
  sessionUser = session?.user || null;
  bind(container);
  wire();
   // ✅ Load section previews
  await refreshSafePreview();
  await refreshMovementPreview();
  autosize(container);
}
