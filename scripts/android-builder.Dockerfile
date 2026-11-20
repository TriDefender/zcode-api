# syntax=docker/dockerfile:1
# Android APK build image for scripts/build-android-apk.sh
# (image llama-android-builder:latest = JDK17 + Gradle 8.9 + Android SDK 35).
#
# 重建：
#   docker build -t llama-android-builder:latest -f scripts/android-builder.Dockerfile scripts/
#   docker run -d --name zcode-android-build-e \
#     -v "<repo-root>:/work" -v zcode-gradle-cache:/root/.gradle \
#     -w /work/Android-APP llama-android-builder:latest sleep infinity
# 版本钉子与 Android-APP/gradle-wrapper.properties + app/build.gradle.kts 对齐：
#   JDK17 / Gradle 8.9 / compileSdk 35 / build-tools 35.0.0。
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jdk-headless curl ca-certificates unzip zip \
    && rm -rf /var/lib/apt/lists/*

# Gradle 8.9（与 wrapper distributionUrl 一致；build-android-apk.sh 调的是系统 gradle；
# AGP 8.5 要求 Gradle >= 8.9）
ARG GRADLE_VERSION=8.9
RUN curl -fsSLo /tmp/gradle.zip \
        "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm /tmp/gradle.zip

# Android cmdline-tools + SDK 35（cmdline-tools 必须落在 $ANDROID_HOME/cmdline-tools/latest）
ARG CMDLINE_TOOLS_VERSION=11076708
ENV ANDROID_HOME=/opt/android-sdk
RUN curl -fsSLo /tmp/clt.zip \
        "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
    && mkdir -p "${ANDROID_HOME}/cmdline-tools" \
    && unzip -q /tmp/clt.zip -d "${ANDROID_HOME}/cmdline-tools" \
    && mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm /tmp/clt.zip
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"
RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    && chmod -R a+rX "${ANDROID_HOME}"
