/// <reference path="../definitions/node.d.ts" />
/// <reference path="../definitions/Q.d.ts" />
/// <reference path="../definitions/shelljs.d.ts" />
/// <reference path="../definitions/minimatch.d.ts" />
/// <reference path="../definitions/glob.d.ts" />

import Q = require('q');
import shell = require('shelljs');
import fs = require('fs');
import path = require('path');
import os = require('os');
import minimatch = require('minimatch');
import globm = require('glob');
import util = require('util');
import tcm = require('./taskcommand');
import trm = require('./toolrunner');

export enum TaskResult {
    Succeeded = 0,
    Failed = 1
}

//-----------------------------------------------------
// String convenience
//-----------------------------------------------------

function startsWith(str: string, start: string): boolean {
    return str.slice(0, start.length) == start;
}

function endsWith(str: string, end: string): boolean {
    return str.slice(-str.length) == end;
}

//-----------------------------------------------------
// General Helpers
//-----------------------------------------------------
export var _outStream = process.stdout;
export var _errStream = process.stderr;

export function _writeError(str: string): void {
    _errStream.write(str + os.EOL);
}

export function _writeLine(str: string): void {
    _outStream.write(str + os.EOL);
}

export function setStdStream(stdStream): void {
    _outStream = stdStream;
}

export function setErrStream(errStream): void {
    _errStream = errStream;
}


//-----------------------------------------------------
// Results and Exiting
//-----------------------------------------------------

export function setResult(result: TaskResult, message: string): void {
    debug('task result: ' + TaskResult[result]);
    command('task.complete', { 'result': TaskResult[result] }, message);

    if (result == TaskResult.Failed) {
        _writeError(message);
    }

    if (result == TaskResult.Failed && !process.env['TASKLIB_INPROC_UNITS']) {
        process.exit(0);
    }
}

export function handlerError(errMsg: string, continueOnError: boolean) {
    if (continueOnError) {
        error(errMsg);
    }
    else {
        setResult(TaskResult.Failed, errMsg);
    }
}

//
// Catching all exceptions
//
process.on('uncaughtException', (err) => {
    setResult(TaskResult.Failed, 'Unhandled:' + err.message);
});

export function exitOnCodeIf(code, condition: boolean) {
    if (condition) {
        setResult(TaskResult.Failed, 'failure return code: ' + code);
    }
}

//
// back compat: should use setResult
//
export function exit(code: number): void {
    setResult(code, 'return code: ' + code);
}

//-----------------------------------------------------
// Loc Helpers
//-----------------------------------------------------
var locStringCache: {
    [key: string]: string
} = {};
var resourceFile: string;
var libResourceFileLoaded: boolean = false;

function loadLocStrings(resourceFile: string): any {
    var locStrings: {
        [key: string]: string
    } = {};

    if (exist(resourceFile)) {
        debug('load loc strings from: ' + resourceFile);
        var resourceJson = require(resourceFile);

        if (resourceJson && resourceJson.hasOwnProperty('messages')) {
            for (var key in resourceJson.messages) {
                if (typeof (resourceJson.messages[key]) === 'object') {
                    if (resourceJson.messages[key].loc && resourceJson.messages[key].loc.toString().length > 0) {
                        locStrings[key] = resourceJson.messages[key].loc.toString();
                    }
                    else if (resourceJson.messages[key].fallback) {
                        locStrings[key] = resourceJson.messages[key].fallback.toString();
                    }
                }
                else if (typeof (resourceJson.messages[key]) === 'string') {
                    locStrings[key] = resourceJson.messages[key];
                }
            }
        }
    }
    else {
        warning('resource file doesn\'t exist: ' + resourceFile);
    }

    return locStrings;
}

export function setResourcePath(path: string): void {
    if (process.env['TASKLIB_INPROC_UNITS']) {
        resourceFile = null;
        libResourceFileLoaded = false;
        locStringCache = {};
    }

    if (!resourceFile) {
        checkPath(path, 'resource file path');
        resourceFile = path;
        debug('set resource file to: ' + resourceFile);

        var locStrs = loadLocStrings(resourceFile);
        for (var key in locStrs) {
            debug('cache loc string: ' + key);
            locStringCache[key] = locStrs[key];
        }

    }
    else {
        warning('resource file is already set to: ' + resourceFile);
    }
}

export function loc(key: string, ...param: any[]): string {
    if (!libResourceFileLoaded) {
        // merge loc strings from vso-task-lib.
        var libResourceFile = path.join(__dirname, 'lib.json');
        var libLocStrs = loadLocStrings(libResourceFile);
        for (var libKey in libLocStrs) {
            debug('cache vso-task-lib loc string: ' + libKey);
            locStringCache[libKey] = libLocStrs[libKey];
        }

        libResourceFileLoaded = true;
    }

    var locString;;
    if (locStringCache.hasOwnProperty(key)) {
        locString = locStringCache[key];
    }
    else {
        if (!resourceFile) {
            warning('resource file haven\'t been set, can\'t find loc string for key: ' + key);
        }
        else {
            warning('can\'t find loc string for key: ' + key);
        }

        locString = key;
    }

    if (param.length > 0) {
        return util.format.apply(this, [locString].concat(param));
    }
    else {
        return locString;
    }

}

//-----------------------------------------------------
// Input Helpers
//-----------------------------------------------------
export function getVariable(name: string): string {
    var varval = process.env[name.replace(/\./g, '_').toUpperCase()];
    debug(name + '=' + varval);
    return varval;
}

export function setVariable(name: string, val: string): void {
    if (!name) {
        _writeError('name required: ' + name);
        exit(1);
    }

    var varValue = val || '';
    process.env[name.replace(/\./g, '_').toUpperCase()] = varValue;
    debug('set ' + name + '=' + varValue);
    command('task.setvariable', { 'variable': name || '' }, varValue);
}

export function getInput(name: string, required?: boolean): string {
    var inval = process.env['INPUT_' + name.replace(' ', '_').toUpperCase()];
    if (inval) {
        inval = inval.trim();
    }

    if (required && !inval) {
        setResult(TaskResult.Failed, 'Input required: ' + name);
    }

    debug(name + '=' + inval);
    return inval;
}

export function getBoolInput(name: string, required?: boolean): boolean {
    return getInput(name, required) == "true";
}

export function setEnvVar(name: string, val: string): void {
    if (val) {
        process.env[name] = val;
    }
}

//
// Split - do not use for splitting args!  Instead use arg() - it will split and handle
//         this is for splitting a simple list of items like targets
//
export function getDelimitedInput(name: string, delim: string, required?: boolean): string[] {
    var inval = getInput(name, required);
    if (!inval) {
        return [];
    }
    return inval.split(delim);
}

export function filePathSupplied(name: string): boolean {
    // normalize paths
    var pathValue = path.resolve(this.getPathInput(name) || '');
    var repoRoot = path.resolve(this.getVariable('build.sourcesDirectory') || '');

    var supplied = pathValue !== repoRoot;
    debug(name + 'path supplied :' + supplied);
    return supplied;
}

export function getPathInput(name: string, required?: boolean, check?: boolean): string {
    var inval = getInput(name, required);
    if (inval) {
        if (check) {
            checkPath(inval, name);
        }

        if (inval.indexOf(' ') > 0) {
            if (!startsWith(inval, '"')) {
                inval = '"' + inval;
            }

            if (!endsWith(inval, '"')) {
                inval += '"';
            }
        }
    }

    debug(name + '=' + inval);
    return inval;
}

//-----------------------------------------------------
// Endpoint Helpers
//-----------------------------------------------------

export function getEndpointUrl(id: string, optional: boolean): string {
    var urlval = process.env['ENDPOINT_URL_' + id];

    if (!optional && !urlval) {
        _writeError('Endpoint not present: ' + id);
        exit(1);
    }

    debug(id + '=' + urlval);
    return urlval;
}

// TODO: should go away when task lib 
export interface EndpointAuthorization {
    parameters: {
        [key: string]: string;
    };
    scheme: string;
}

export function getEndpointAuthorization(id: string, optional: boolean): EndpointAuthorization {
    var aval = process.env['ENDPOINT_AUTH_' + id];

    if (!optional && !aval) {
        setResult(TaskResult.Failed, 'Endpoint not present: ' + id);
    }

    debug(id + '=' + aval);

    var auth: EndpointAuthorization;
    try {
        auth = <EndpointAuthorization>JSON.parse(aval);
    }
    catch (err) {
        setResult(TaskResult.Failed, 'Invalid endpoint auth: ' + aval); // exit
    }

    return auth;
}

//-----------------------------------------------------
// Fs Helpers
//-----------------------------------------------------
export interface FsStats extends fs.Stats {

}

export function stats(path: string): FsStats {
    return fs.statSync(path);
}

export function exist(path: string): boolean {
    return path && fs.existsSync(path);
}

//-----------------------------------------------------
// Cmd Helpers
//-----------------------------------------------------
export function command(command: string, properties, message: string) {
    var taskCmd = new tcm.TaskCommand(command, properties, message);
    _writeLine(taskCmd.toString());
}

export function warning(message: string): void {
    command('task.issue', { 'type': 'warning' }, message);
}

export function error(message: string): void {
    command('task.issue', { 'type': 'error' }, message);
}

export function debug(message: string): void {
    command('task.debug', null, message);
}

var _argStringToArray = function(argString: string): string[] {
    var args = argString.match(/([^" ]*("[^"]*")[^" ]*)|[^" ]+/g);

    for (var i = 0; i < args.length; i++) {
        args[i] = args[i].replace(/"/g, "");
    }
    return args;
}

export function cd(path: string): void {
    if (path) {
        shell.cd(path);
    }
}

export function pushd(path: string): void {
    shell.pushd(path);
}

export function popd(): void {
    shell.popd();
}

//------------------------------------------------
// Validation Helpers
//------------------------------------------------
export function checkPath(p: string, name: string): void {
    debug('check path : ' + p);
    if (!exist(p)) {
        setResult(TaskResult.Failed, 'not found ' + name + ': ' + p);  // exit
    }
}

//-----------------------------------------------------
// Shell/File I/O Helpers
// Abstract these away so we can
// - default to good error handling
// - inject system.debug info
// - have option to switch internal impl (shelljs now)
//-----------------------------------------------------
export function mkdirP(p): boolean {
    var success = true;

    try {
        if (!p) {
            throw new Error('path not supplied');
        }
        
        // certain chars like \0 will cause shelljs and fs
        // to blow up without exception or error
        if (p.indexOf('\0') >= 0) {
            throw new Error('path cannot contain null bytes');
        }

        if (!shell.test('-d', p)) {
            debug('creating path: ' + p);
            shell.mkdir('-p', p);
            var errMsg = shell.error();
            if (errMsg) {
                handlerError(errMsg, false);
                success = false;
            }
        }
        else {
            debug('path exists: ' + p);
        }
    }
    catch (err) {
        success = false;
        handlerError('Failed mkdirP: ' + err.message, false);
    }

    return success;
}

export function which(tool: string, check?: boolean): string {
    try {
        // we can't use shelljs.which() on windows due to https://github.com/shelljs/shelljs/issues/238
        // shelljs.which() does not prefer file with executable extensions (.exe, .bat, .cmd).
        // we already made a PR for Shelljs, but they haven't merge it yet. https://github.com/shelljs/shelljs/pull/239
        if (os.type().match(/^Win/)) {
            var pathEnv = process.env.path || process.env.Path || process.env.PATH;
            var pathArray = pathEnv.split(';');
            var toolPath: string = null;

            // No relative/absolute paths provided?
            if (tool.search(/[\/\\]/) === -1) {
                // Search for command in PATH
                pathArray.forEach(function(dir) {
                    if (toolPath)
                        return; // already found it

                    var attempt = path.resolve(dir + '/' + tool);

                    var baseAttempt = attempt;
                    attempt = baseAttempt + '.exe';
                    if (exist(attempt) && stats(attempt).isFile) {
                        toolPath = attempt;
                        return;
                    }
                    attempt = baseAttempt + '.cmd';
                    if (exist(attempt) && stats(attempt).isFile) {
                        toolPath = attempt;
                        return;
                    }
                    attempt = baseAttempt + '.bat';
                    if (exist(attempt) && stats(attempt).isFile) {
                        toolPath = attempt;
                        return;
                    }
                });
            }

            // Command not found in Path, but the input itself is point to a file.
            if (!toolPath && exist(tool) && stats(tool).isFile)
                toolPath = path.resolve(tool);
        }
        else {
            var toolPath = shell.which(tool);
        }

        if (check) {
            checkPath(toolPath, tool);
        }

        debug(tool + '=' + toolPath);
        return toolPath;
    }
    catch (err) {
        handlerError('Failed which: ' + err.message, false);
    }
}

export function cp(options, source: string, dest: string, continueOnError?: boolean): boolean {
    var success = true;

    try {
        shell.cp(options, source, dest);
        var errMsg = shell.error();

        if (errMsg) {
            handlerError(errMsg, continueOnError);
            success = false;
        }
    }
    catch (err) {
        success = false;
        handlerError('Failed cp: ' + err.message, false);
    }

    return success;
}

export function mv(source: string, dest: string, force: boolean, continueOnError?: boolean): boolean {
    var success = true;

    try {
        if (force) {
            shell.mv('-f', source, dest);
        } else {
            shell.mv(source, dest);
        }
        var errMsg = shell.error();

        if (errMsg) {
            handlerError(errMsg, continueOnError);
            success = false;
        }
    }
    catch (err) {
        success = false;
        handlerError('Failed mv: ' + err.message, false);
    }

    return success;
}

export function find(findPath: string): string[] {
    try {
        if (!shell.test('-e', findPath)) {
            return [];
        }
        var matches = shell.find(findPath);
        debug('find ' + findPath);
        debug(matches.length + ' matches.');
        return matches;
    }
    catch (err) {
        handlerError('Failed find: ' + err.message, false);
    }
}

export function rmRF(path: string, continueOnError?: boolean): boolean {
    var success = true;

    try {
        debug('rm -rf ' + path);
        shell.rm('-rf', path);

        var errMsg: string = shell.error();
        
        // if you try to delete a file that doesn't exist, desired result is achieved
        // other errors are valid
        if (errMsg && !(errMsg.indexOf('ENOENT') === 0)) {
            handlerError(errMsg, continueOnError);
            success = false;
        }
    }
    catch (err) {
        success = false;
        handlerError('Failed rmRF: ' + err.message, false);
    }

    return success;
}

export function glob(pattern: string): string[] {
    debug('glob ' + pattern);
    var matches: string[] = globm.sync(pattern);
    debug('found ' + matches.length + ' matches');

    if (matches.length > 0) {
        var m = Math.min(matches.length, 10);
        debug('matches:');
        if (m == 10) {
            debug('listing first 10 matches as samples');
        }

        for (var i = 0; i < m; i++) {
            debug(matches[i]);
        }
    }

    return matches;
}

export function globFirst(pattern: string): string {
    debug('globFirst ' + pattern);
    var matches = glob(pattern);

    if (matches.length > 1) {
        warning('multiple workspace matches.  using first.');
    }

    debug('found ' + matches.length + ' matches');

    return matches[0];
}

//-----------------------------------------------------
// Exec convenience wrapper
//-----------------------------------------------------
export function exec(tool: string, args: any, options?: trm.IExecOptions): Q.Promise<number> {
    var toolPath = which(tool, true);
    var tr = createToolRunner(toolPath);
    if (args) {
        tr.arg(args);
    }
    return tr.exec(options);
}

export function execSync(tool: string, args: any, options?: trm.IExecOptions): trm.IExecResult {
    var toolPath = which(tool, true);
    var tr = createToolRunner(toolPath);
    if (args) {
        tr.arg(args);
    }

    return tr.execSync(options);
}

export function createToolRunner(tool: string) {
    var tr: trm.ToolRunner = new trm.ToolRunner(tool);
    tr.on('debug', (message: string) => {
        debug(message);
    })

    return tr;
}

//-----------------------------------------------------
// Matching helpers
//-----------------------------------------------------
export function match(list, pattern, options): string[] {
    return minimatch.match(list, pattern, options);
}

export function filter(pattern, options): (element: string, indexed: number, array: string[]) => boolean {
    return minimatch.filter(pattern, options);
}    

//-----------------------------------------------------
// Test Publisher
//-----------------------------------------------------
export class TestPublisher {
    constructor(testRunner) {
        this.testRunner = testRunner;
    }

    public testRunner: string;

    public publish(resultFiles, mergeResults, platform, config, runTitle, publishRunAttachments) {

        if (mergeResults == 'true') {
            _writeLine("Merging test results from multiple files to one test run is not supported on this version of build agent for OSX/Linux, each test result file will be published as a separate test run in VSO/TFS.");
        }

        var properties = <{ [key: string]: string }>{};
        properties['type'] = this.testRunner;

        if (platform) {
            properties['platform'] = platform;
        }

        if (config) {
            properties['config'] = config;
        }

        if (runTitle) {
            properties['runTitle'] = runTitle;
        }

        if (publishRunAttachments) {
            properties['publishRunAttachments'] = publishRunAttachments;
        }

        for (var i = 0; i < resultFiles.length; i++) {
            properties['fileNumber'] = i.toString();
            command('results.publish', properties, resultFiles[i]);
        }
    }
}

//-----------------------------------------------------
// Tools
//-----------------------------------------------------
exports.TaskCommand = tcm.TaskCommand;
exports.commandFromString = tcm.commandFromString;
exports.ToolRunner = trm.ToolRunner;
trm.debug = debug;


