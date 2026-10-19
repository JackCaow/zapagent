//go:build darwin

#include <stdint.h>
#include <stdlib.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOMessage.h>
#include <IOKit/pwr_mgt/IOPMLib.h>

extern void zapvmPowerCallback(uintptr_t handle, uint32_t messageType);

typedef struct zapvm_power_monitor {
    io_connect_t root_port;
    IONotificationPortRef notification_port;
    io_object_t notifier;
    CFRunLoopRef run_loop;
    CFRunLoopSourceRef source;
    uintptr_t handle;
} zapvm_power_monitor;

static void zapvm_power_callback(void *refcon, io_service_t service, natural_t message_type, void *message_argument) {
    (void)service;
    zapvm_power_monitor *monitor = (zapvm_power_monitor *)refcon;
    zapvmPowerCallback(monitor->handle, (uint32_t)message_type);
    if (message_type == kIOMessageCanSystemSleep || message_type == kIOMessageSystemWillSleep) {
        IOAllowPowerChange(monitor->root_port, (long)message_argument);
    }
}

zapvm_power_monitor *zapvm_power_create(uintptr_t handle) {
    zapvm_power_monitor *monitor = calloc(1, sizeof(*monitor));
    if (monitor == NULL) {
        return NULL;
    }
    monitor->handle = handle;
    monitor->root_port = IORegisterForSystemPower(monitor, &monitor->notification_port, zapvm_power_callback, &monitor->notifier);
    if (monitor->root_port == MACH_PORT_NULL || monitor->notification_port == NULL) {
        free(monitor);
        return NULL;
    }
    monitor->source = IONotificationPortGetRunLoopSource(monitor->notification_port);
    monitor->run_loop = CFRunLoopGetCurrent();
    if (monitor->source == NULL || monitor->run_loop == NULL) {
        IODeregisterForSystemPower(&monitor->notifier);
        IOServiceClose(monitor->root_port);
        IONotificationPortDestroy(monitor->notification_port);
        free(monitor);
        return NULL;
    }
    CFRetain(monitor->run_loop);
    CFRunLoopAddSource(monitor->run_loop, monitor->source, kCFRunLoopCommonModes);
    return monitor;
}

void zapvm_power_run(zapvm_power_monitor *monitor) {
    if (monitor != NULL) {
        CFRunLoopRun();
    }
}

void zapvm_power_stop(zapvm_power_monitor *monitor) {
    if (monitor != NULL && monitor->run_loop != NULL) {
        CFRunLoopStop(monitor->run_loop);
    }
}

void zapvm_power_destroy(zapvm_power_monitor *monitor) {
    if (monitor == NULL) {
        return;
    }
    CFRunLoopRemoveSource(monitor->run_loop, monitor->source, kCFRunLoopCommonModes);
    IODeregisterForSystemPower(&monitor->notifier);
    IOServiceClose(monitor->root_port);
    IONotificationPortDestroy(monitor->notification_port);
    CFRelease(monitor->run_loop);
    free(monitor);
}
