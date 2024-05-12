declare module 'indexeddbshim/dist/indexeddbshim-noninvasive' {
  type ConfigValues = {
    checkOrigin: boolean;
    win: WindowDatabase;
  }

  function setGlobalVars(idb: unknown, initialConfig: ConfigValues): void; 
  export = setGlobalVars;
}
