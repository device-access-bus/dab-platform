/**
    Copyright 2019 Amazon.com, Inc. or its affiliates.
    Copyright 2019 Netflix Inc.
    Copyright 2019 Google LLC

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at
        http://www.apache.org/licenses/LICENSE-2.0
    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/

const mqtt = require('mqtt');
const {spawn} = require('child_process');

const client = mqtt.connect('mqtt://localhost');
const appsPid = [];  // Array of {appId: <app_id>, pid: <PID>, intervalId: <ID>}
// TODO: should have a lock to access/modify appsPid?

client.on('connect', () => {
    console.log('we are connected');

    // subscribe to the desired topics
    client.subscribe([
        'platform/input/remote/#',
        'platform/telemetry/monitor/start/+',
        'platform/telemetry/monitor/stop/+',
        'apps/+/status/lifecycle'
    ]);
});

const mappings = {
    "prime-video" : {
        "play": "7",
        "pause" : "7",
        "left" : "Left",
        "right" : "Right",
        "up": "Up",
        "down": "Down",
        "OK": "Return",
        "FWD": "0",
        "RWD": "9"
    },
    "youtube" : {
        "play": "k",
        "pause" : "k",
        "left" : "Left",
        "right" : "Right",
        "up": "Up",
        "down": "Down",
        "OK": "Return",
        "FWD": "l",
        "RWD": "j"
    },
    "netflix" : {
        "play": "Return",
        "pause" : "Return",
        "left" : "Left",
        "right" : "Right",
        "up": "Up",
        "down": "Down",
        "OK": "Return",
        "FWD": "Right",
        "RWD": "Left"
    }
};

function discoverWindowAndPress(app_id, key_code) {
    // find the window
    // send the key code
    let window_id = '';
    let search_process = spawn('xdotool', ['search', '--name', app_id]);

    search_process.stdout.on('data', (chunk) => {
        window_id += chunk.toString();
    });

    search_process.on('exit', () => {
        // send the key stroke
        spawn('xdotool', ['key', '--window', window_id, key_code])
    })
}

function translate(action, app_id) {
    return mappings[app_id][action];
}

function onPlatformInputRemote(topic, message) {
    // Handler for platform/input/remote/#
    const topicParts = topic.split('/');
    if (topicParts.length !== 5) {
        console.log('Invalid topic: ' + topic);
        return;
    }

    const obj = JSON.parse(message.toString());
    const appId = obj["app_id"];
    const action = topicParts[3];

    let keyCode = translate(action, appId);
    if (!keyCode) {
        keyCode = action;
    }

    if (appId === 'prime-video') {
        discoverWindowAndPress('Amazon Prime Video', keyCode)
    } else {
        spawn('xdotool', ['key', keyCode])
    }

    client.publish('_response/' + topic, JSON.stringify({status: 200}))
}

function onAppsAppidStatusLifecycle(topic, message) {
    // Handler for apps/+/status/lifecycle
    // Gets the pid of the app and store it in appsPid
    const match = topic.match('apps/([^/]*)/status/lifecycle')
    if (!match) {
        console.log('Invalid topic: ' + topic);
        return;
    }

    const appId = match[1];
    const obj = JSON.parse(message.toString());
    const status = obj["status"];
    const pid = obj["pid"];

    var index;
    const numApps = appsPid.length;
    for (index = 0; index < numApps; index++) {
        if (appsPid[index]["appId"] == appId) {
            break;
        }
    }
    if (index < numApps) {
        if (status == "started") {
            if (appsPid[index]["pid"] != pid) {
                appsPid[index]["pid"] = pid;
                // TODO: stop existing monitoring if any.
                appsPid[index]["intervalId"] = null;
            }
        } else {
            appsPid[index]["pid"] = null;
            appsPid[index]["intervalId"] = null;
        }
    } else {
        appsPid.push({appId: appId, pid: pid, intervalId: null});
    }
    console.log('Received status for ' + appId + ': pid = ' + appsPid[index]["pid"]);
}

function onPlatformTelemetryMonitorStart(topic, message) {
    // Handler for platform/telemetry/monitor/start/<req_id>
    const topicParts = topic.split('/');
    if (topicParts.length !== 5 ||
        !topic.startsWith('platform/telemetry/monitor/start/')) {
        console.log('Invalid topic: ' + topic);
        return;
    }

    const obj = JSON.parse(message.toString());
    const appId = obj["app_id"];
    const pid = getAppPid(appId);

    if (!pid) {
        console.log('App ' + appId + ' is not currently running!');
        return;
    }
    monitorTopic = startMonitoring(appId, pid);

    client.publish(
        '_response/' + topic,
        JSON.stringify({
            status: 200,
            topic: monitorTopic
        }));
}

function onPlatformTelemetryMonitorStop(topic, message) {
    // Handler for platform/telemetry/monitor/stop/<req_id>
    const topicParts = topic.split('/');
    if (topicParts.length !== 5 ||
        !topic.startsWith('platform/telemetry/monitor/stop/')) {
        console.log('Invalid topic: ' + topic);
        return;
    }

    const obj = JSON.parse(message.toString());
    const appId = obj["app_id"];

    stopMonitoring(appId);

    client.publish(
        '_response/' + topic,
        JSON.stringify({status: 200}));
}

function getAppIndex(appId) {
    // Return index of the given app in the appsPid array, or null
    // if it does not exist yet.
    var index;
    const numApps = appsPid.length;
    for (index = 0; index < numApps; index++) {
        if (appsPid[index]["appId"] == appId) {
            return index;
        }
    }
    return null;
}

function getAppPid(appId) {
    // Get the PID of the given app, received previously from the bus,
    // or null if the app is not running.
    const index = getAppIndex(appId);
    if (index == null) {
      return null;
    }
    return appsPid[index]["pid"];
}

function displayMemoryUsage(pid, topic) {
    // Gets the memory usage of the given pid and publish the data
    // to the given topic.
    const cmd = "top -n1 -b | grep " + pid + " | awk '{ print $6 }'";
    let top_process = spawn('sh', ['-c', cmd]);

    let memUsagekB = '';
    top_process.stdout.on('data', (chunk) => {
        memUsagekB += chunk.toString();
    });

    top_process.on('exit', () => {
        // Publish the memory usage.
        payload = JSON.stringify({memory_kB: memUsagekB})
        console.log('Sending memory usage: topic: ' + topic + ' message: ', payload)
        client.publish(topic, payload)
    })
}

function startMonitoring(appId, pid) {
    // Start publishing memory usage every second.
    topic = 'platform/telemetry/monitor/' + appId;
    console.log('Start publishing to ' + topic + ' every second');

    var appIndex = getAppIndex(appId);
    if (appIndex == null) {
        console.log('Internal error... missing entry for ' + appId);
        return
    }
    const intervalId = setInterval(() => {
        displayMemoryUsage(pid, topic);
    }, 1000);
    appsPid[appIndex]["intervalId"] = intervalId;

    return topic
}

function stopMonitoring(appId) {
    // Stop pusblishing memory usage.
    console.log('Stop monitoring for ' + appId);

    var appIndex = getAppIndex(appId);
    if (appIndex == null) {
        console.log('Internal error... missing entry for ' + appId);
        return
    }
    const intervalId = appsPid[appIndex]["intervalId"];
    if (!intervalId) {
        console.log('Internal error... missing intervalId.');
        return
    }
    clearInterval(intervalId);
}

client.on('message', (topic, message) => {
    console.log('Received a new message: topic: ' + topic + ' message: ' + message);
    if (topic.startsWith('platform/input/remote/')) {
        onPlatformInputRemote(topic, message);
    } else if (topic.startsWith('platform/telemetry/monitor/start/')) {
        onPlatformTelemetryMonitorStart(topic, message);
    } else if (topic.startsWith('platform/telemetry/monitor/stop/')) {
        onPlatformTelemetryMonitorStop(topic, message);
    } else if (topic.match('apps/[^/]*/status/lifecycle')) {
        onAppsAppidStatusLifecycle(topic, message);
    } else {
        console.log('Unsupported topic: ' + topic);
    }
});

