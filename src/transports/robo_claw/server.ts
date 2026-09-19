/**
 * gRPC server abstraction for the RoboClaw transport.
 *
 * Exposes a clean interface so tests can inject a memory-based fake server
 * without binding real network ports or touching C-bindings.
 */

import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { RoboClawChatMessage } from "./normalize.js";

export interface GrpcStreamCall {
	readonly metadata?: Readonly<Record<string, string | string[]>>;
	on(event: "data", listener: (msg: RoboClawChatMessage) => void): this;
	on(event: "end", listener: () => void): this;
	on(event: "error", listener: (err: Error) => void): this;
	write(msg: RoboClawChatMessage): boolean;
	end(): void;
	destroy(error?: Error): void;
}

export interface RoboMessengerHandlers {
	chatStream(call: GrpcStreamCall): void;
}

export interface GrpcServerAdapter {
	start(host: string, port: number, handlers: RoboMessengerHandlers): Promise<number>;
	stop(): Promise<void>;
}

interface ProtoDescriptor {
	robo_claw: {
		RoboMessenger: {
			service: grpc.ServiceDefinition;
		};
	};
}

export class DefaultGrpcServerAdapter implements GrpcServerAdapter {
	private server: grpc.Server | null = null;

	async start(host: string, port: number, handlers: RoboMessengerHandlers): Promise<number> {
		const server = new grpc.Server();
		const protoPath = fileURLToPath(new URL("./proto/messenger.proto", import.meta.url));
		const packageDefinition = protoLoader.loadSync(protoPath, {
			keepCase: true,
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true,
		});
		const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as ProtoDescriptor;

		server.addService(proto.robo_claw.RoboMessenger.service, {
			chatStream: (call: grpc.ServerDuplexStream<RoboClawChatMessage, RoboClawChatMessage>) => {
				const metadataMap: Record<string, string | string[]> = {};
				const rawMap = call.metadata.getMap();
				for (const [k, v] of Object.entries(rawMap)) {
					if (typeof v === "string") {
						metadataMap[k] = v;
					} else if (Buffer.isBuffer(v)) {
						metadataMap[k] = v.toString("utf8");
					}
				}

				const wrappedCall: GrpcStreamCall = {
					metadata: metadataMap,
					on: (event: "data" | "end" | "error", listener: any) => {
						call.on(event, listener);
						return wrappedCall;
					},
					write: (msg: RoboClawChatMessage) => {
						return call.write(msg);
					},
					end: () => {
						call.end();
					},
					destroy: (error?: Error) => {
						call.destroy(error);
					},
				};
				handlers.chatStream(wrappedCall);
			},
		});

		const boundPort = await new Promise<number>((resolve, reject) => {
			server.bindAsync(
				`${host}:${port}`,
				grpc.ServerCredentials.createInsecure(),
				(err, actualPort) => {
					if (err) reject(err);
					else resolve(actualPort);
				},
			);
		});

		this.server = server;
		return boundPort;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = null;
		await new Promise<void>((resolve) => {
			server.tryShutdown((err) => {
				if (err) {
					server.forceShutdown();
				}
				resolve();
			});
		});
	}
}
