"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configProviderNested = void 0;
var effect_1 = require("effect");
var configProviderNested = function (prefix) {
    return effect_1.ConfigProvider.fromEnv().pipe(effect_1.ConfigProvider.nested(prefix), effect_1.ConfigProvider.constantCase);
};
exports.configProviderNested = configProviderNested;
