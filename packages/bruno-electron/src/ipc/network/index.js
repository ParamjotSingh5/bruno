const axios = require('axios');
const Mustache = require('mustache');
const FormData = require('form-data');
const { ipcMain } = require('electron');
const { forOwn, extend, each } = require('lodash');
const { ScriptRuntime } = require('@usebruno/js');
const prepareRequest = require('./prepare-request');
const { cancelTokens, saveCancelToken, deleteCancelToken } = require('../../utils/cancel-token');
const { uuid } = require('../../utils/common');
const interpolateVars = require('./interpolate-vars');

// override the default escape function to prevent escaping
Mustache.escape = function (value) {
  return value;
};

const safeStringifyJSON = (data) => {
  try {
    return JSON.stringify(data);
  } catch (e) {
    return data;
  }
};

const safeParseJSON = (data) => {
  try {
    return JSON.parse(data);
  } catch (e) {
    return data;
  }
};

const getEnvVars = (environment = {}) => {
  const variables = environment.variables;
  if (!variables || !variables.length) {
    return {};
  }

  const envVars = {};
  each(variables, (variable) => {
    if(variable.enabled) {
      envVars[variable.name] = Mustache.escape(variable.value);
    }
  });

  return envVars;
};

const registerNetworkIpc = (mainWindow, watcher, lastOpenedCollections) => {
  // handler for sending http request
  ipcMain.handle('send-http-request', async (event, item, collectionUid, collectionPath, environment) => {
    const cancelTokenUid = uuid();

    try {
      const _request = item.draft ? item.draft.request : item.request;
      const request = prepareRequest(_request);

      // make axios work in node using form data
      // reference: https://github.com/axios/axios/issues/1006#issuecomment-320165427
      if(request.headers && request.headers['content-type'] === 'multipart/form-data') {
        const form = new FormData();
        forOwn(request.data, (value, key) => {
          form.append(key, value);
        });
        extend(request.headers, form.getHeaders());
        request.data = form;
      }

      const cancelToken = axios.CancelToken.source();
      request.cancelToken = cancelToken.token;
      saveCancelToken(cancelTokenUid, cancelToken);

      const envVars = getEnvVars(environment);

      if(request.script && request.script.length) {
        let script = request.script + '\n if (typeof onRequest === "function") {onRequest(brunoRequest);}';
        const scriptRuntime = new ScriptRuntime();
        const res = scriptRuntime.runRequestScript(script, request, envVars, collectionPath);

        mainWindow.webContents.send('main:script-environment-update', {
          environment: res.environment,
          collectionUid
        });
      }

      interpolateVars(request, envVars);

      // todo:
      // i have no clue why electron can't send the request object 
      // without safeParseJSON(safeStringifyJSON(request.data))
      mainWindow.webContents.send('main:http-request-sent', {
        requestSent: {
          url: request.url,
          method: request.method,
          headers: request.headers,
          data: safeParseJSON(safeStringifyJSON(request.data))
        },
        collectionUid,
        itemUid: item.uid,
        cancelTokenUid
      });

      const result = await axios(request);

      if(request.script && request.script.length) {
        let script = request.script + '\n if (typeof onResponse === "function") {onResponse(brunoResponse);}';
        const scriptRuntime = new ScriptRuntime();
        const res = scriptRuntime.runResponseScript(script, result, envVars, collectionPath);

        mainWindow.webContents.send('main:script-environment-update', {
          environment: res.environment,
          collectionUid
        });
      }

      deleteCancelToken(cancelTokenUid);

      return {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        data: result.data
      };
    } catch (error) {
      deleteCancelToken(cancelTokenUid);

      if(error.response) {
        return {
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers,
          data: error.response.data
        }
      };

      return Promise.reject(error);
    }
  });

  ipcMain.handle('cancel-http-request', async (event, cancelTokenUid) => {
    return new Promise((resolve, reject) => {
      if(cancelTokenUid && cancelTokens[cancelTokenUid]) {
        cancelTokens[cancelTokenUid].cancel();
        deleteCancelToken(cancelTokenUid);
        resolve();
      } else {
        reject(new Error("cancel token not found"));
      }
    });
  });
};

module.exports = registerNetworkIpc;
