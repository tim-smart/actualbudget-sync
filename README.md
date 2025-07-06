# @tim-smart/actualbudget-sync

A CLI to sync with Actual Budget.

Features:

- Syncs transactions from banks like Akahu and Up to Actual Budget.
- If the bank supports pending transactions, it will also sync those for
  real-time updates.
  - When the pending transaction is cleared, it will update the transaction
    in Actual Budget with the cleared amount.
  - If the payee name is updated by the bank, it will also update the
    transaction in Actual Budget if you haven't renamed it already.
- Automatically matches the API client with the Actual server version, so you
  don't have to worry about keeping up-to-date.
- Supports categorization of transactions for banks that support it.

## Installation

### NPM

You can install the CLI using npm:

```bash
npm install -g @tim-smart/actualbudget-sync
```

> [!NOTE]  
> If the installation fails, check that the prerequisites specified in the
[node-gyp](https://github.com/nodejs/node-gyp?tab=readme-ov-file#installation) 
transitive dependency have been met. In general you'll need to have installed 
Python and C++ build tools specific to your operating system. 

Here is a quick example of how to use the CLI:

```bash
# Set the environment variables for Actual Budget
export ACTUAL_SERVER=https://actual.example.com
export ACTUAL_SYNC_ID=xxx
export ACTUAL_PASSWORD=xxx
# Where to store the sync data. It defaults to ./data
export ACTUAL_DATA=/data

# Set the environment variables for the bank you want to sync with
export AKAHU_APP_TOKEN=xxx
export AKAHU_USER_TOKEN=xxx

actualsync --bank akahu \
  --accounts 'actual-account-id=bank-account-id' \
  --accounts 'actual-account-id2=bank-account-id2'
```

> [!IMPORTANT]  
> The IDs used above are not the names of the accounts. The easiest way to find these IDs is to inspect the URL when viewing the account in question in Actual or Akahu.

### Docker

You can also use the pre-built docker image: [`timsmart/actualbudget-sync:main`](https://hub.docker.com/r/timsmart/actualbudget-sync).

Here is an example of how to run the docker image:

```bash
docker run -it --rm \
  -e ACTUAL_SERVER=https://actual.example.com \
  -e ACTUAL_SYNC_ID=xxx \
  -e ACTUAL_PASSWORD=xxx \
  -e ACTUAL_DATA=/data \
  -e AKAHU_APP_TOKEN=xxx \
  -e AKAHU_USER_TOKEN=xxx \
  -v /path/to/data:/data \
  timsmart/actualbudget-sync:main --bank akahu \
  --accounts 'actual-account-id=bank-account-id' \
  --accounts 'actual-account-id2=bank-account-id2' \
```

### Kubernetes

Here is an example of how to run the docker image in a Kubernetes CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: actualsync
  namespace: actualsync
spec:
  schedule: 7 9-19/2 * * *
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            job: actualsync
        spec:
          containers:
            - name: sync
              image: timsmart/actualbudget-sync:main
              args:
                - "--bank"
                - akahu
                - "--accounts"
                - actual-account-id=bank-account-id
                - "--accounts"
                - actual-account-id2=bank-account-id2
              imagePullPolicy: Always
              # put your secrets in a Kubernetes secret
              envFrom:
                - secretRef:
                    name: actualsync-env
              env:
                - name: ACTUAL_SERVER
                  value: https://actual.example.com
                - name: ACTUAL_DATA
                  value: /data
              volumeMounts:
                - name: data
                  mountPath: /data
          restartPolicy: OnFailure
          volumes:
            - name: data
              persistentVolumeClaim:
                claimName: data
      parallelism: 1
      completions: 1
```

## Usage

Here is a copy of the CLI help:

```
actualsync

actualsync 0.0.1

USAGE

$ actualsync --bank akahu | up --accounts text [(-c, --categorize)] [--categories text]

OPTIONS

--bank akahu | up

  One of the following: akahu, up

  Which bank to use

--accounts text

  A user-defined piece of text.

  Accounts to sync, in the format 'actual-account-id=bank-account-id'

  This setting is a property argument which:

    - May be specified a single time:  '--accounts key1=value key2=value2'

    - May be specified multiple times: '--accounts key1=value --accounts key2=value2'

(-c, --categorize)

  A true or false value.

  If the bank supports categorization, try to categorize transactions

  This setting is optional.

--categories text

  A user-defined piece of text.

  Requires --categorize to have any effect. Maps the banks values to actual values with the format 'bank-category=actual-category'

  This setting is a property argument which:

    - May be specified a single time:  '--categories key1=value key2=value2'

    - May be specified multiple times: '--categories key1=value --categories key2=value2'

  This setting is optional.
```

You will also need to set these environment variables:

```
# Your Actual Budget server URL
ACTUAL_SERVER=https://actual.example.com
# Your Actual Budget sync ID and password
ACTUAL_SYNC_ID=xxx
ACTUAL_PASSWORD=xxx

# For the Akahu bank, you will also need to set these:
AKAHU_APP_TOKEN=xxx
AKAHU_USER_TOKEN=xxx

# For the Up bank, you will also need to set these:
UP_USER_TOKEN=xxx
```
