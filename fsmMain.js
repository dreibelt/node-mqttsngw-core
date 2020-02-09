const FSM = require('edfsm');
module.exports = (bus, log, gwId) => {
	const clientFactory = require('./fsmClient.js')(bus, log);
	return FSM({
		fsmName: '[Core] Main',
		log: log,
		input: bus,
		output: bus,
		firstState: 'init',
		gwId: gwId
	}).state('init', (ctx, i, o, next) => {
		ctx.clients = {};
		next('listening');
	}).state('listening', (ctx, i, o, next) => {
		// Listen for CONNECT messages from the sensor network
		i(['snUnicastIngress', '*', 'connect'], (packet) => {
			if (ctx.clients[packet.clientKey]) {
				// This client already has a connection and may not have heard
				// its connack packet. Thus, we repeat what we said before.
				ctx.clients[packet.clientKey].ctx.connack.then((connack) => {
					o(['snUnicastOutgress', packet.clientKey, 'connack'], connack);
				});
			} else {
				// New client -> new client instance
				ctx.clients[packet.clientKey] = clientFactory.run(packet, () => {
					delete ctx.clients[packet.clientKey];
				});
			}
		});
		// TODO: SEARCHGW, ADVERTISE
		i(['snUnicastIngress', '*', 'searchgw'], (packet) => {
			o(['snUnicastOutgress', packet.clientKey, 'gwinfo'], {
				cmd: 'gwinfo',
				gwId: ctx.gwId
			});
		});

		//TODO: Configurations
		var interval = 900 * 1000; 
		var advertise = setInterval(() => {
			o(['snUnicastOutgress', '*', 'advertise'], {
				cmd: 'gwinfo',
				gwId: ctx.gwId,
				duration: 900
			});
		}, interval);
	}).final((ctx, i, o, end) => {
		Object.keys(ctx.clients).forEach((key) => {
			ctx.clients[key].next(null);
		});
		end();
	});
};
