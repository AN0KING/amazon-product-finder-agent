export class CliError extends Error {
    exitCode;
    code;
    details;
    constructor(exitCode, code, message, details = {}) {
        super(message);
        this.exitCode = exitCode;
        this.code = code;
        this.details = details;
    }
    withDetails(details) {
        this.details = { ...this.details, ...details };
        return this;
    }
}
//# sourceMappingURL=errors.js.map