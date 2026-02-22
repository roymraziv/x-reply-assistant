let state = { masterPrompt: '', presets: [], activePresetId: null, apiKey: '' };

async function loadState() {
  const data = await chrome.storage.local.get(['masterPrompt', 'presets', 'activePresetId', 'apiKey']);
  state.masterPrompt = data.masterPrompt || '';
  state.presets = data.presets || [];
  state.activePresetId = data.activePresetId || null;
  state.apiKey = data.apiKey || '';
}

async function saveState(partial) {
  await chrome.storage.local.set(partial);
  Object.assign(state, partial);
}

function renderPresets() {
  const list = document.getElementById('presetList');
  list.innerHTML = '';

  if (state.presets.length === 0) {
    list.innerHTML = '<p class="empty">No presets yet. Add one below.</p>';
    return;
  }

  state.presets.forEach(preset => {
    const row = document.createElement('div');
    row.className = 'preset-row' + (preset.id === state.activePresetId ? ' active' : '');
    row.innerHTML = `
      <label>
        <input type="radio" name="activePreset" value="${preset.id}" ${preset.id === state.activePresetId ? 'checked' : ''} />
        <span>${preset.label}</span>
      </label>
      <div class="preset-actions">
        <button data-id="${preset.id}" class="edit-btn">Edit</button>
        <button data-id="${preset.id}" class="delete-btn">✕</button>
      </div>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('input[type=radio]').forEach(radio => {
    radio.addEventListener('change', async () => {
      await saveState({ activePresetId: radio.value });
      renderPresets();
      showStatus('Active preset updated.');
    });
  });

  list.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => loadPresetForEdit(btn.dataset.id));
  });

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deletePreset(btn.dataset.id));
  });
}

function loadPresetForEdit(id) {
  const preset = state.presets.find(p => p.id === id);
  if (!preset) return;
  document.getElementById('editingPresetId').value = id;
  document.getElementById('newPresetLabel').value = preset.label;
  document.getElementById('newPresetIntent').value = preset.intent;
  document.getElementById('cancelEdit').style.display = 'inline-block';
  document.getElementById('savePreset').textContent = 'Update Preset';
}

function clearPresetForm() {
  document.getElementById('editingPresetId').value = '';
  document.getElementById('newPresetLabel').value = '';
  document.getElementById('newPresetIntent').value = '';
  document.getElementById('cancelEdit').style.display = 'none';
  document.getElementById('savePreset').textContent = 'Save Preset';
}

async function deletePreset(id) {
  const updated = state.presets.filter(p => p.id !== id);
  const newActive = state.activePresetId === id ? (updated[0]?.id || null) : state.activePresetId;
  await saveState({ presets: updated, activePresetId: newActive });
  renderPresets();
  showStatus('Preset deleted.');
}

function showStatus(msg) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  setTimeout(() => el.textContent = '', 2500);
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadState();

  document.getElementById('apiKey').value = state.apiKey;
  document.getElementById('masterPrompt').value = state.masterPrompt;
  renderPresets();

  document.getElementById('saveApiKey').addEventListener('click', async () => {
    await saveState({ apiKey: document.getElementById('apiKey').value.trim() });
    showStatus('API key saved.');
  });

  document.getElementById('saveMasterPrompt').addEventListener('click', async () => {
    await saveState({ masterPrompt: document.getElementById('masterPrompt').value.trim() });
    showStatus('Master prompt saved.');
  });

  document.getElementById('savePreset').addEventListener('click', async () => {
    const editingId = document.getElementById('editingPresetId').value;
    const label = document.getElementById('newPresetLabel').value.trim();
    const intent = document.getElementById('newPresetIntent').value.trim();

    if (!label || !intent) { showStatus('Label and intent are required.'); return; }

    let updatedPresets;
    let newActivePresetId = state.activePresetId;

    if (editingId) {
      updatedPresets = state.presets.map(p => p.id === editingId ? { ...p, label, intent } : p);
      showStatus('Preset updated.');
    } else {
      const newPreset = { id: `preset_${Date.now()}`, label, intent };
      updatedPresets = [...state.presets, newPreset];
      // Auto-activate first preset
      if (updatedPresets.length === 1) {
        newActivePresetId = newPreset.id;
      }
      showStatus('Preset added.');
    }

    await saveState({ presets: updatedPresets, activePresetId: newActivePresetId });
    clearPresetForm();
    renderPresets();
  });

  document.getElementById('cancelEdit').addEventListener('click', () => {
    clearPresetForm();
  });
});
