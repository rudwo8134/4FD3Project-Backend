import { NestFactory } from '@nestjs/core';
import {
  randomUUID as nodeRandomUUID,
  webcrypto as nodeWebCrypto,
} from 'crypto';
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = nodeWebCrypto ?? { randomUUID: nodeRandomUUID };
}
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Resume Backend API')
    .setDescription('API documentation for the Resume Backend')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
