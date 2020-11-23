import * as cdk from '@aws-cdk/core';
import { RestApi, LambdaIntegration, Cors } from '@aws-cdk/aws-apigateway';
import { Table, AttributeType, BillingMode } from '@aws-cdk/aws-dynamodb';
import { Rule, Schedule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';
import { Function, Runtime, Code, LayerVersion } from '@aws-cdk/aws-lambda';
import { Queue } from '@aws-cdk/aws-sqs';
import { SqsEventSource } from '@aws-cdk/aws-lambda-event-sources';
import { Duration } from '@aws-cdk/core';

export class AwsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ************************************************************************
    // ************************ simple lambda function ************************
    // ************************************************************************

    const simpleFunction = new Function(this, 'simple-function', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: Code.asset('./handlers/simple'),
      environment: {
        HELLO: "Hello",
        WORLD: "World"
      },
      timeout: Duration.seconds(2)
    });

    const simpleApi = new RestApi(this, 'simple-api', {
      restApiName: 'Simple API sample',
      description: "Simple API sample with no dependencies"
    });

    simpleApi.root.addMethod('GET', new LambdaIntegration(
      simpleFunction,
      {
        requestTemplates: { "application/json": '{ "statusCode": "200" }' }
      }
    ));

    // ************************************************************************
    // ********************* layer definition and usage ***********************
    // ************************************************************************

    const layer = new LayerVersion(this, 'sample-layer', {
      // Code.fromAsset must reference the build folder
      code: Code.fromAsset('./layers/build/sample-layer'),
      compatibleRuntimes: [Runtime.NODEJS_12_X],
      license: 'MIT',
      description: 'A sample layer for the layer and dynamodb test functions',
    });

    // layer test function
    const layerFunction = new Function(this, 'layer-function', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: Code.asset('./handlers/layer'),
      layers: [layer]
    });

    const layerApi = new RestApi(this, 'layer-api');

    layerApi.root.addMethod('GET', new LambdaIntegration(layerFunction));

    // ************************************************************************
    // ****************** dynamodb table and functions ************************
    // ************************************************************************

    // If you're note already familiar with DynamoDB's reserved keywords, it's
    // worth checking your attribute names against
    // [this list](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html).
    // NOTE: remove timeToLiveAttribute if you don't want to set a TTL for the data
    const dynamodbTable = new Table(this, 'dynamodb-table', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiration'
    });

    const dynamodbGetFunction = new Function(this, 'dynamodb-function-get', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'get.handler',
      code: Code.asset('./handlers/dynamodb'),
      environment: {
        TABLE_NAME: dynamodbTable.tableName
      },
      layers: [layer]
    });

    dynamodbTable.grantReadData(dynamodbGetFunction);

    const dynamodbScanFunction = new Function(this, 'dynamodb-function-scan', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'scan.handler',
      code: Code.asset('./handlers/dynamodb'),
      environment: {
        TABLE_NAME: dynamodbTable.tableName
      },
      layers: [layer]
    });

    dynamodbTable.grantReadData(dynamodbScanFunction);
    // create reusable lambda integration
    let dynamodbScanFunctionIntegration = new LambdaIntegration(dynamodbScanFunction);

    const dynamodbCreateFunction = new Function(this, 'dynamodb-function-create', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'create.handler',
      code: Code.asset('./handlers/dynamodb'),
      environment: {
        TABLE_NAME: dynamodbTable.tableName
      },
      layers: [layer]
    });

    dynamodbTable.grantWriteData(dynamodbCreateFunction);

    const dynamodbUpdateFunction = new Function(this, 'dynamodb-function-update', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'update.handler',
      code: Code.asset('./handlers/dynamodb'),
      environment: {
        TABLE_NAME: dynamodbTable.tableName
      },
      layers: [layer]
    });

    dynamodbTable.grantWriteData(dynamodbUpdateFunction);

    // RESTful API CORS options object
    let corsOptions = {
      allowOrigins: Cors.ALL_ORIGINS,
      allowMethods: Cors.ALL_METHODS,
    };

    // Configure RESTful API
    // If set, defaultCorsPreflightOptions will apply to all child
    // resources
    const dynamodbApi = new RestApi(this, 'dynamodb-api', {
      defaultCorsPreflightOptions: corsOptions
    });

    // /objects
    // https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/objects
    let apiObjects = dynamodbApi.root.addResource('objects');

    // If not already set by a parent's defaultCorsPreflightOptions,
    // uncomment this to enable cors on a specific api resource
    // apiObjects.addCorsPreflight(corsOptions);

    // GET /objects : list all objects
    apiObjects.addMethod('GET', dynamodbScanFunctionIntegration);
    // POST /objects : add a new object
    apiObjects.addMethod('POST', new LambdaIntegration(dynamodbCreateFunction));

    // objects/{id}
    let apiObjectsObject = apiObjects.addResource("{objectId}")

    // GET /objects/{id} : get object with specified id
    apiObjectsObject.addMethod('GET', new LambdaIntegration(dynamodbGetFunction));
    // PUT /objects/{id} : update object with specified id
    apiObjectsObject.addMethod('PUT', new LambdaIntegration(dynamodbUpdateFunction));

    // ************************************************************************
    // ******************** sqs queue and functions ***************************
    // ************************************************************************

    const sqsQueue = new Queue(this, 'sqs-queue');

    const queuePublishFunction = new Function(this, 'queue-function-publish', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'index.publish',
      code: Code.asset('./handlers/sqs'),
      environment: {
        QUEUE_URL: sqsQueue.queueUrl,
        TABLE_NAME: dynamodbTable.tableName
      },
      layers: [layer]
    });

    sqsQueue.grantSendMessages(queuePublishFunction);

    const queueSubscribeFunction = new Function(this, 'queue-function-subscribe', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'index.subscribe',
      code: Code.asset('./handlers/sqs'),
      environment: {
        QUEUE_URL: sqsQueue.queueUrl,
        TABLE_NAME: dynamodbTable.tableName
      },
      layers: [layer]
    });

    // WARNING: unlike the rest of the serverless resources, setting up an
    //          SQS queue event listener incurs costs even when there's no
    //          activity (something in the order of 50 cents/month). From
    //          https://aws.amazon.com/blogs/aws/aws-lambda-adds-amazon-simple-queue-service-to-supported-event-sources/
    //    "There are no additional charges for this feature, but because the
    //     Lambda service is continuously long-polling the SQS queue the
    //     account will be charged for those API calls at the standard SQS
    //     pricing rates."
    let queueEventSource = new SqsEventSource(sqsQueue, {
      batchSize: 10 // default
    });

    queueSubscribeFunction.addEventSource(queueEventSource);

    dynamodbTable.grantWriteData(queueSubscribeFunction);

    // sqs api
    const sqsApi = new RestApi(this, 'sqs-api');

    sqsApi.root.addMethod('POST', new LambdaIntegration(queuePublishFunction));

    // reuse dynamodb scan function
    sqsApi.root.addMethod('GET', dynamodbScanFunctionIntegration);

    // ************************************************************************
    // ************************ scheduled function ****************************
    // ************************************************************************

    const scheduledFunction = new Function(this, 'scheduled-function', {
      runtime: Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: Code.asset('./handlers/scheduled'),
      timeout: Duration.seconds(2)
    });

    // configure rule for a scheduled function
    // recommended period for warming up functions is 15 minutes
    const rule = new Rule(this, `scheduled-function-rule`, {
      schedule: Schedule.rate(Duration.minutes(15))
    });

    // CAUTION: uncommenting this line will cause the lambda function
    //          to be invoked at the specified interval. If not actually
    //          required it's bad form to leave it running: aside from
    //          potential cost to you, it's also a waste of resources
    //          others might need.
    //rule.addTarget(new LambdaFunction(scheduledFunction));
  }
}