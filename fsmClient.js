const FSM = require('edfsm');
module.exports = (bus, log) => {
	const subscribeFactory = require('./fsmSubscribe.js')(bus, log);
	const unsubscribeFactory = require('./fsmUnsubscribe.js')(bus, log);
	const publishToBrokerFactory = require('./fsmPublishToBroker.js')(bus, log);
	const publishToClientFactory = require('./fsmPublishToClient.js')(bus, log);
	return FSM({
		fsmName: '[Core] Client',
		log: log,
		input: bus,
		output: bus,
		firstState: 'init'
	}).state('init', (ctx, i, o, next) => {
		// Convert received packet into context
		delete ctx.cmd;
		ctx.connectedToClient = false;
		ctx.connectedToBroker = false;
		ctx.topics = [];
		ctx.sleepingMessageStore = [];

		// Create promise for for conack
		ctx.connack = new Promise((resolve) => { ctx.connackResolve = resolve; });

		// Select next state depending on the will flag
		if (ctx.will) next('willTopic');
		else next('connectBroker');
	}).state('willTopic', (ctx, i, o, next) => {
		// TODO
		next(new Error('willTopic is not implemented'));
	}).state('willMessage', (ctx, i, o, next) => {
		// TODO
		next(new Error('willMessage is not implemented'));
	}).state('connectBroker', (ctx, i, o, next) => {

		// Wait for a result from the broker
		i(['brokerConnect', ctx.clientKey, 'res'], (res) => {
			// Broker module returned an error
			if (res.error) return next(new Error(res.error));

			// Connection was successfully established
			ctx.sessionResumed = res.sessionResumed;
			ctx.connectedToBroker = true;
			const connack = {
				clientKey: ctx.clientKey,
				cmd: 'connack',
				returnCode: 'Accepted'
			};
			ctx.connackResolve(connack);
			o(['snUnicastOutgress', ctx.clientKey, 'connack'], connack);
			ctx.connectedToClient = true;
			next('active');
		});

		
		// Ask broker module to conncet to broker
		o(['brokerConnect', ctx.clientKey, 'req'], Object.assign({}, ctx));

		// The broker module must return at least a timeout!
		// -> No next.timeout() in this state.
	}).state('active', (ctx, i, o, next) => {
		// Listen for disconnects from client
		i(['snUnicastIngress', ctx.clientKey, 'disconnect'], (data) => {
			var duration = data.duration || 0;
			ctx.duration = duration;
			if(duration > 0){
				next('asleep');
			}
			else {
				next(null);
			}
		});

		// Listen for disconnects from broker
		i(['brokerDisconnect', ctx.clientKey, 'notify'], (data) => {
			ctx.connectedToBroker = false;
			next(null);
		});

		// React to register events
		i(['snUnicastIngress', ctx.clientKey, 'register'], (data) => {
			// TODO: Check if space in topic store is left
			let topicId = ctx.topics.indexOf(data.topicName) + 1;
			if (topicId === 0) topicId = ctx.topics.push(data.topicName);
			o(['snUnicastOutgress', ctx.clientKey, 'regack'], {
				clientKey: ctx.clientKey,
				cmd: 'regack',
				msgId: data.msgId,
				topicId: topicId,
				returnCode: 'Accepted'
			});
		});

		// Handle subscribe
		i(['snUnicastIngress', ctx.clientKey, 'subscribe'], (data) => {
			// Kick-off new state machine to handle subscribe messages
			data.topics = ctx.topics;
			subscribeFactory.run(data);
		});

		// Handle unsubscribe
		i(['snUnicastIngress', ctx.clientKey, 'unsubscribe'], (data) => {
			// Kick-off new state machine to handle subscribe messages
			unsubscribeFactory.run(data);
		});

		// Handle publish to broker
		i(['snUnicastIngress', ctx.clientKey, 'publish'], (data) => {
			// Kick-off new state machine to handle publish messages
			data.topics = ctx.topics;
			publishToBrokerFactory.run(data);
		});

		i(['brokerPublishToClient', ctx.clientKey, 'req'], (data) => {
			// Kick-off new state machine to handle publish messages
			data.topics = ctx.topics;
			publishToClientFactory.run(data);
		});

		// TODO: Handle will updates

		// React to ping requests while active
		i(['snUnicastIngress', ctx.clientKey, 'pingreq'], () => {
			o(['snUnicastOutgress', ctx.clientKey, 'pingresp'], {
				clientKey: ctx.clientKey,
				cmd: 'pingresp'
			});
		});

		// clear message buffer
		while(ctx.sleepingMessageStore.length > 0){
			var data = ctx.sleepingMessageStore.shift();
			data.topics = ctx.topics;
			publishToClientFactory.run(data);
		}

		// Timeout after given duration. This will be reset by any ingress packet.
		i(['snUnicastIngress', ctx.clientKey, '*'], () => timeoutTrigger());
		timeoutTrigger();
		function timeoutTrigger () {
			next.timeout(ctx.duration * 1000, new Error('Received no ping requests within given connection duration'));
		}
	}).state('asleep', (ctx, i, o, next) => {
		// TODO: Wake
		// client events must transition back to active with pingreq
		// at the completion of this transmition, the waking event 
		// should then be consumed 
		// React to ping requests while asleep
		i(['snUnicastIngress', ctx.clientKey, 'pingreq'], () => {
			next('awake');
		});

		// Handle reconnect
		i(['snUnicastIngress', ctx.clientKey, 'connect'], (data) => {
			// Connection was successfully established
			ctx.sessionResumed = true;
			ctx.connectedToBroker = true;
			const connack = {
				clientKey: ctx.clientKey,
				cmd: 'connack',
				returnCode: 'Accepted'
			};
			ctx.connackResolve(connack);
			o(['snUnicastOutgress', ctx.clientKey, 'connack'], connack);
			ctx.connectedToClient = true;
			next('active');
		});

		i(['snUnicastIngress', ctx.clientKey, 'disconnect'], (data) => {
			var duration = data.duration || 0;
			ctx.duration = duration;
			if(duration > 0){
				o(['snUnicastOutgress', ctx.clientKey, 'disconnect'], {
					clientKey: ctx.clientKey,
					duration: duration,
					cmd: 'disconnect'
				});
				timeoutTrigger();

			}
			else {
				next(null);
			}
		});
		
		// TODO: Sleep Storage responses
		i(['brokerPublishToClient', ctx.clientKey, 'req'], (data) => {
			// Kick-off new state machine to handle publish messages
			ctx.sleepingMessageStore.push(data);
			// TODO: Responses should be handled 
		});

		o(['snUnicastOutgress', ctx.clientKey, 'disconnect'], {
			clientKey: ctx.clientKey,
			duration: ctx.duration,
			cmd: 'disconnect'
		});

		timeoutTrigger();
		function timeoutTrigger () {
			next.timeout(ctx.duration * 1000, new Error('Received no ping requests within given connection duration'));
		}

	}).state('awake', (ctx, i, o, next) => {
		// disconnect
		i(['snUnicastIngress', ctx.clientKey, 'disconnect'], (data) => {
			var duration = data.duration || 0;
			if(duration > 0){
				next('asleep');
			}
			else {
				next(null);
			}
		});

		// TODO: Sleep Storage responses
		// an awake state can still queue new messages
		i(['brokerPublishToClient', ctx.clientKey, 'req'], (data) => {
			// Kick-off new state machine to handle publish messages
			ctx.sleepingMessageStore.push(data);
			// TODO: Responses should be handled 
		});

		// after a sleep
		if(ctx.sleepingMessageStore.length > 0){
			// TODO: 
			// These message may require different response handling
			// since they were delayed in transport
			while(ctx.sleepingMessageStore.length > 0){
				var data = ctx.sleepingMessageStore.shift();
				data.topics = ctx.topics;
				publishToClientFactory.run(data);
			}
			
		}
		
		o(['snUnicastOutgress', ctx.clientKey, 'pingresp'], {
			clientKey: ctx.clientKey,
			cmd: 'pingresp'
		});
		next('asleep');

	}).final((ctx, i, o, end, err) => {
		if (!ctx.connectedToClient) {
			// Send negative connack, since the error occured
			// while establishing connection
			const connack = {
				clientKey: ctx.clientKey,
				cmd: 'connack',
				returnCode: 'Rejected: congestion'
			};
			ctx.connackResolve(connack);
			o(['snUnicastOutgress', ctx.clientKey, 'connack'], connack);
		} else {
			// TODO: Check if error is not null?
			//       -> Send last will

			// Send disconnect message to client
			o(['snUnicastOutgress', ctx.clientKey, 'disconnect'], {
				clientKey: ctx.clientKey,
				cmd: 'disconnect'
			});
		}

		if (ctx.connectedToBroker) {
			o(['brokerDisconnect', ctx.clientKey, 'call'], {
				clientKey: ctx.clientKey
			});
		}

		end(err);
	});
};
