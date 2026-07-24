// Bridge for the "Vault password" window. The user's chosen password is passed to the
// main process, which re-encrypts the vault under it and re-uploads the ciphertext — the
// password never leaves this machine except as end-to-end-encrypted vault data.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeperVault", {
  status: () => ipcRenderer.invoke("keeper:vault-status"),
  setPassword: (password) => ipcRenderer.invoke("keeper:set-vault-password", { password }),
});
