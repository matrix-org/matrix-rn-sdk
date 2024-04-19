module.exports = {
    plugins: ["matrix-org", "import"],
    extends: ["plugin:matrix-org/babel", "plugin:matrix-org/jest", "plugin:import/typescript"],
    parserOptions: {
        project: ["./tsconfig.json"],
    },
    env: {
        node: true,
    },
    settings: {
        "import/resolver": {
            typescript: true,
            node: true,
        },
    }
};
